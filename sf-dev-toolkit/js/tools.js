// =============================================================================
// tools.js — the daily-driver tools: SOQL, anonymous Apex, REST, logs, limits
// and the small conversions.
// =============================================================================

var lastQueryRows = [];
var loadedLogs = [];
var currentLogBody = "";

// ── shared: flatten a SOQL record for tabular display ────────────────────────
function flattenRecord(rec, prefix, out) {
    out = out || {};
    Object.keys(rec).forEach(function (k) {
        if (k === "attributes") return;
        var v = rec[k];
        var key = prefix ? prefix + "." + k : k;
        if (v && typeof v === "object" && !Array.isArray(v) && v.attributes) flattenRecord(v, key, out);
        else if (v && typeof v === "object") out[key] = JSON.stringify(v);
        else out[key] = v;
    });
    return out;
}

// ── SOQL ─────────────────────────────────────────────────────────────────────
var QUERY_TEMPLATES = [
    ["Recently modified Apex classes", "SELECT Id, Name, ApiVersion, LastModifiedBy.Name, LastModifiedDate FROM ApexClass ORDER BY LastModifiedDate DESC LIMIT 50"],
    ["Active users and profiles", "SELECT Id, Name, Username, Profile.Name, UserType, LastLoginDate FROM User WHERE IsActive = true ORDER BY LastLoginDate DESC LIMIT 100"],
    ["Permission set assignments", "SELECT Assignee.Name, PermissionSet.Label, PermissionSet.IsOwnedByProfile FROM PermissionSetAssignment WHERE PermissionSet.IsOwnedByProfile = false ORDER BY Assignee.Name LIMIT 200"],
    ["Failed async jobs", "SELECT Id, ApexClass.Name, JobType, Status, NumberOfErrors, ExtendedStatus, CreatedDate FROM AsyncApexJob WHERE Status IN ('Failed','Aborted') ORDER BY CreatedDate DESC LIMIT 50"],
    ["Scheduled jobs", "SELECT Id, CronJobDetail.Name, State, NextFireTime, PreviousFireTime FROM CronTrigger ORDER BY NextFireTime LIMIT 50"],
    ["Recent debug logs", "SELECT Id, LogUser.Name, Operation, Status, LogLength, StartTime FROM ApexLog ORDER BY StartTime DESC LIMIT 50"],
    ["Setup audit trail", "SELECT CreatedDate, CreatedBy.Name, Section, Action, Display FROM SetupAuditTrail ORDER BY CreatedDate DESC LIMIT 100"],
    ["Login history (7 days)", "SELECT UserId, LoginTime, SourceIp, Status, Application, Browser FROM LoginHistory WHERE LoginTime = LAST_N_DAYS:7 ORDER BY LoginTime DESC LIMIT 200"],
    ["Custom objects (tooling)", "SELECT Id, DeveloperName, NamespacePrefix, Description FROM CustomObject ORDER BY DeveloperName LIMIT 200"],
    ["Apex test coverage (tooling)", "SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate ORDER BY NumLinesUncovered DESC LIMIT 100"],
    ["Flow definitions", "SELECT ApiName, Label, ProcessType, TriggerType, IsActive, LastModifiedDate FROM FlowDefinitionView ORDER BY LastModifiedDate DESC LIMIT 100"],
    ["Deployments today (tooling)", "SELECT Id, Status, StartDate, CompletedDate, CreatedBy.Name, NumberComponentErrors FROM DeployRequest WHERE CreatedDate = TODAY ORDER BY CreatedDate DESC LIMIT 25"]
];

(function fillQueryTemplates() {
    var sel = $("queryTemplates");
    QUERY_TEMPLATES.forEach(function (t, i) {
        var o = document.createElement("option");
        o.value = String(i); o.textContent = t[0];
        sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
        var t = QUERY_TEMPLATES[parseInt(sel.value, 10)];
        if (!t) return;
        $("soqlInput").value = t[1];
        $("queryTooling").checked = /tooling/i.test(t[0]) || /CustomObject|ApexCodeCoverage|DeployRequest/.test(t[1]);
        sel.value = "";
        runQuery();
    });
})();

async function runQuery() {
    if (!SFPE.ready) { toast("Connect to an org first.", true); return; }
    var soql = $("soqlInput").value.trim();
    if (!soql) return;
    $("queryStatus").textContent = "Running…";
    $("queryResult").innerHTML = loadingHTML("Querying…");
    $("btnQueryCsv").hidden = $("btnQueryCopy").hidden = true;
    var t0 = performance.now();
    try {
        var records = await pagedQuery(soql, $("queryTooling").checked, $("queryAll").checked);
        lastQueryRows = records.map(function (r) { return flattenRecord(r); });
        var ms = Math.round(performance.now() - t0);
        var shown = lastQueryRows.slice(0, 2000);
        renderTable($("queryResult"), shown);
        $("queryStatus").textContent = lastQueryRows.length + " rows in " + ms + " ms" +
            (lastQueryRows.length > shown.length ? " · showing first 2000, export for the rest" : "");
        $("btnQueryCsv").hidden = $("btnQueryCopy").hidden = lastQueryRows.length === 0;
    } catch (err) {
        $("queryResult").innerHTML = emptyHTML(err.message);
        $("queryStatus").textContent = "Query failed.";
    }
}

$("btnRunQuery").addEventListener("click", runQuery);
$("soqlInput").addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runQuery(); }
});
$("btnQueryCsv").addEventListener("click", function () { downloadCSVFromRows(lastQueryRows, "soql_result.csv"); });
$("btnQueryCopy").addEventListener("click", function () { copyText(rowsToTSV(lastQueryRows), "Result copied as TSV"); });

// ── Anonymous Apex ───────────────────────────────────────────────────────────
var APEX_SNIPPETS = [
    ["Who am I", "System.debug(UserInfo.getName() + ' / ' + UserInfo.getUserName() + ' / ' + UserInfo.getProfileId());"],
    ["Assign a permission set to me", "PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'My_Permission_Set' LIMIT 1];\ninsert new PermissionSetAssignment(AssigneeId = UserInfo.getUserId(), PermissionSetId = ps.Id);"],
    ["Abort every scheduled job", "for (CronTrigger ct : [SELECT Id FROM CronTrigger WHERE State != 'DELETED']) {\n    System.abortJob(ct.Id);\n}"],
    ["Record counts for an object", "System.debug('Accounts: ' + [SELECT COUNT() FROM Account]);"],
    ["Current governor limits", "System.debug('Queries: ' + Limits.getQueries() + '/' + Limits.getLimitQueries());\nSystem.debug('DML rows: ' + Limits.getDmlRows() + '/' + Limits.getLimitDmlRows());"],
    ["Send a platform event", "// EventBus.publish(new My_Event__e(Payload__c = 'test'));"]
];

(function fillApexSnippets() {
    var sel = $("apexTemplates");
    APEX_SNIPPETS.forEach(function (s, i) {
        var o = document.createElement("option");
        o.value = String(i); o.textContent = s[0];
        sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
        var s = APEX_SNIPPETS[parseInt(sel.value, 10)];
        if (s) $("apexInput").value = s[1];
        sel.value = "";
    });
})();

async function runApex() {
    if (!SFPE.ready) { toast("Connect to an org first.", true); return; }
    var code = $("apexInput").value;
    if (!code.trim()) return;
    $("apexStatus").textContent = "Executing…";
    var out = $("apexResult");
    out.textContent = "";
    try {
        var res = await callApi(apiPath("/tooling/executeAnonymous/?anonymousBody=") + encodeURIComponent(code));
        if (!res.success) { out.textContent = "Request failed: " + res.error; $("apexStatus").textContent = "Failed."; return; }
        var d = res.data || {};
        var lines = [];
        if (!d.compiled) {
            lines.push("Compile error on line " + d.line + ", column " + d.column);
            lines.push(d.compileProblem || "");
        } else if (!d.success) {
            lines.push("Ran, then threw: " + (d.exceptionMessage || ""));
            lines.push(d.exceptionStackTrace || "");
        } else {
            lines.push("Executed successfully.");
        }
        out.textContent = lines.join("\n");
        $("apexStatus").textContent = d.compiled && d.success ? "Success." : "Finished with errors.";

        // pull the debug log this run produced, if trace flags are on
        try {
            var logs = await pagedQuery("SELECT Id FROM ApexLog WHERE Operation = 'Api' ORDER BY StartTime DESC LIMIT 1");
            if (logs.length) {
                var body = await callApi(apiPath("/sobjects/ApexLog/" + logs[0].Id + "/Body"));
                var text = body.success ? (body.data && body.data.raw ? body.data.raw : "") : "";
                var debugLines = text.split("\n").filter(function (l) { return /USER_DEBUG|EXCEPTION|FATAL_ERROR/.test(l); });
                if (debugLines.length) out.textContent += "\n\n— debug lines —\n" + debugLines.join("\n");
            }
        } catch (e) {}
    } catch (err) {
        out.textContent = err.message;
        $("apexStatus").textContent = "Failed.";
    }
}
$("btnRunApex").addEventListener("click", runApex);
$("btnApexClear").addEventListener("click", function () { $("apexResult").textContent = ""; $("apexStatus").textContent = "Ready."; });
$("apexInput").addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runApex(); }
});

// ── REST explorer ────────────────────────────────────────────────────────────
async function sendRest() {
    if (!SFPE.ready) { toast("Connect to an org first.", true); return; }
    var method = $("restMethod").value;
    var path = $("restPath").value.trim();
    if (!path) return;
    if (path.indexOf("/") !== 0) path = "/" + path;
    var bodyText = $("restBody").value.trim();
    var body = null;
    if (bodyText && method !== "GET") {
        try { body = JSON.parse(bodyText); }
        catch (e) { toast("Request body isn't valid JSON.", true); return; }
    }
    $("restStatus").textContent = method + " " + path + " …";
    $("restResult").textContent = "";
    var res = await callApi(SFPE.apiBase + path, null, method, body);
    $("restStatus").textContent = "HTTP " + (res.status || (res.success ? 200 : "error")) + (res.success ? "" : " — " + res.error);
    $("restResult").textContent = res.data ? JSON.stringify(res.data, null, 2) : (res.success ? "(empty response)" : res.error);
    $("btnRestCopy").hidden = false;
}
$("btnRestSend").addEventListener("click", sendRest);
$("restPath").addEventListener("keydown", function (e) { if (e.key === "Enter") sendRest(); });
$("btnRestCopy").addEventListener("click", function () { copyText($("restResult").textContent, "Response copied"); });

// ── Debug logs ───────────────────────────────────────────────────────────────
async function loadLogs() {
    if (!SFPE.ready) { toast("Connect to an org first.", true); return; }
    $("logList").innerHTML = loadingHTML("Loading logs…");
    try {
        var where = $("logsMineOnly").checked && SFPE.user ? " WHERE LogUserId = '" + escSoql(SFPE.user.id) + "'" : "";
        loadedLogs = await pagedQuery(
            "SELECT Id, LogUser.Name, Operation, Application, Status, LogLength, DurationMilliseconds, StartTime FROM ApexLog" +
            where + " ORDER BY StartTime DESC LIMIT 50");
        $("logCount").textContent = loadedLogs.length;
        var host = $("logList");
        host.innerHTML = "";
        if (!loadedLogs.length) { host.innerHTML = emptyHTML("No logs. Turn on a trace flag in Setup → Debug Logs."); return; }
        loadedLogs.forEach(function (l) {
            var row = document.createElement("div");
            row.className = "list-item";
            var c = document.createElement("div"); c.className = "item-content";
            var t = document.createElement("div"); t.className = "item-label";
            t.textContent = l.Operation + " · " + l.Status;
            var s = document.createElement("div"); s.className = "item-api";
            s.textContent = new Date(l.StartTime).toLocaleTimeString() + " · " + Math.round((l.LogLength || 0) / 1024) + " KB · " +
                (l.DurationMilliseconds || 0) + " ms · " + ((l.LogUser && l.LogUser.Name) || "");
            c.appendChild(t); c.appendChild(s);
            row.appendChild(c);
            row.addEventListener("click", function () {
                document.querySelectorAll("#logList .list-item").forEach(function (x) { x.classList.remove("selected"); });
                row.classList.add("selected");
                openLog(l.Id);
            });
            host.appendChild(row);
        });
        $("logStatus").textContent = loadedLogs.length + " logs";
    } catch (err) {
        $("logList").innerHTML = emptyHTML("Could not load logs: " + err.message);
    }
}

async function openLog(id) {
    $("logBody").textContent = "Loading…";
    var res = await callApi(apiPath("/sobjects/ApexLog/" + id + "/Body"));
    currentLogBody = res.success ? ((res.data && res.data.raw) || JSON.stringify(res.data)) : ("Could not read log: " + res.error);
    applyLogFilter();
}

function applyLogFilter() {
    var q = $("logFilter").value.trim();
    if (!q) { $("logBody").textContent = currentLogBody; return; }
    $("logBody").textContent = currentLogBody.split("\n").filter(function (l) { return l.toLowerCase().indexOf(q.toLowerCase()) !== -1; }).join("\n") || "No lines match.";
}
$("logFilter").addEventListener("input", applyLogFilter);
$("btnLoadLogs").addEventListener("click", loadLogs);
$("btnCopyLog").addEventListener("click", function () { copyText($("logBody").textContent, "Log copied"); });
$("btnDeleteLogs").addEventListener("click", async function () {
    if (!loadedLogs.length) { toast("Load the list first.", true); return; }
    if (!confirm("Delete the " + loadedLogs.length + " logs listed here? This cannot be undone.")) return;
    var ok = 0;
    for (var i = 0; i < loadedLogs.length; i++) {
        var r = await callApi(apiPath("/sobjects/ApexLog/" + loadedLogs[i].Id), null, "DELETE");
        if (r.success) ok++;
    }
    toast("Deleted " + ok + " logs");
    loadLogs();
});

// ── Limits ───────────────────────────────────────────────────────────────────
async function loadLimits() {
    if (!SFPE.ready) { toast("Connect to an org first.", true); return; }
    $("limitsStatus").textContent = "Loading…";
    var res = await callApi(apiPath("/limits"));
    if (!res.success) { $("limitsStatus").textContent = res.error; return; }
    var grid = $("limitsGrid");
    grid.innerHTML = "";
    var keys = Object.keys(res.data).sort();
    keys.forEach(function (k) {
        var v = res.data[k];
        if (!v || typeof v.Max !== "number") return;
        var used = v.Max - v.Remaining;
        var pct = v.Max ? Math.round((used / v.Max) * 100) : 0;
        var card = document.createElement("div");
        card.className = "limit" + (pct >= 80 ? " hot" : pct >= 60 ? " warm" : "");
        var b = document.createElement("b"); b.textContent = k.replace(/([A-Z])/g, " $1").trim();
        var n = document.createElement("div"); n.className = "nums";
        n.textContent = used.toLocaleString() + " / " + v.Max.toLocaleString() + "  ·  " + pct + "% used";
        var bar = document.createElement("div"); bar.className = "bar";
        var fill = document.createElement("span"); fill.style.width = Math.min(pct, 100) + "%";
        bar.appendChild(fill);
        card.appendChild(b); card.appendChild(n); card.appendChild(bar);
        grid.appendChild(card);
    });
    $("limitsStatus").textContent = "Updated " + new Date().toLocaleTimeString();
}
$("btnLoadLimits").addEventListener("click", loadLimits);
document.addEventListener("sfpe:view", function (e) { if (e.detail === "limits" && !$("limitsGrid").children.length) loadLimits(); });

// ── Utilities ────────────────────────────────────────────────────────────────
function to18(id) {
    if (id.length !== 15) return id;
    var suffix = "";
    for (var i = 0; i < 3; i++) {
        var flags = 0;
        for (var j = 0; j < 5; j++) {
            var c = id.charAt(i * 5 + j);
            if (c >= "A" && c <= "Z") flags += 1 << j;
        }
        suffix += "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345".charAt(flags);
    }
    return id + suffix;
}

$("btnConvertId").addEventListener("click", function () {
    var v = $("idInput").value.trim();
    if (!/^[a-zA-Z0-9]{15,18}$/.test(v)) { $("idOutput").textContent = "That isn't a 15 or 18 character id."; return; }
    var out = v.length === 15 ? to18(v) : v.slice(0, 15);
    $("idOutput").textContent = out + "   (" + (v.length === 15 ? "18-char" : "15-char") + ")";
    copyText(out, "Converted id copied");
});
$("idInput").addEventListener("keydown", function (e) { if (e.key === "Enter") $("btnConvertId").click(); });

$("btnPrefix").addEventListener("click", async function () {
    var p = $("prefixInput").value.trim();
    if (p.length !== 3) { $("prefixOut").textContent = "Enter exactly three characters."; return; }
    if (!allObjects.length) {
        var res = await callApi(apiPath("/sobjects/"));
        if (res.success) allObjects = res.data.sobjects || [];
    }
    var hits = allObjects.filter(function (o) { return o.keyPrefix === p; });
    $("prefixOut").textContent = hits.length
        ? hits.map(function (o) { return o.name + " — " + o.label; }).join("\n")
        : "No object in this org uses the prefix " + p + ".";
});
$("prefixInput").addEventListener("keydown", function (e) { if (e.key === "Enter") $("btnPrefix").click(); });

$("btnOpenId").addEventListener("click", function () {
    if (!SFPE.ready) { toast("Connect to an org first.", true); return; }
    var v = $("openIdInput").value.trim();
    if (!v) return;
    if (/^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/.test(v)) openInTab(SFPE.lightningBase + "/lightning/r/" + v + "/view");
    else openInTab(SFPE.lightningBase + "/lightning/setup/ObjectManager/" + encodeURIComponent(v) + "/Details/view");
});
$("openIdInput").addEventListener("keydown", function (e) { if (e.key === "Enter") $("btnOpenId").click(); });

$("btnClearCaches").addEventListener("click", function () {
    describeCache = {};
    toast("Describe cache cleared — next load reads fresh metadata.");
});
$("btnClearClipboard2").addEventListener("click", wipeClipboard);
$("btnClearSession2").addEventListener("click", function () { clearSession(); });
