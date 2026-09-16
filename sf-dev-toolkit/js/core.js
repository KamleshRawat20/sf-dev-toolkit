// =============================================================================
// core.js — connection, session handling, API access, shared UI plumbing.
//
// The session token lives in this file, in memory, and nowhere else. It is
// never written to localStorage / chrome.storage, never logged, and only ever
// leaves the extension inside an Authorization header aimed at the org it came
// from (background.js enforces that host check).
// =============================================================================

var SFPE = {
    apiVersion: "62.0",
    apiBase: null,          // https://xxx.my.salesforce.com
    lightningBase: null,
    org: null,              // { name, id, type, sandbox, instance, ... }
    user: null,             // { name, username, profile, id }
    manual: false,          // session came from a pasted token
    ready: false,
    _readyCbs: []
};

var sessionId = null;       // ← the secret. memory only.
var currentApiBase = null;  // kept for module compatibility
var describeCache = {};

// ── tiny helpers ─────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function matches(text, q) { return !q || (text || "").toLowerCase().includes(q.toLowerCase()); }
function loadingHTML(msg) { return '<div class="loading"><span class="spinner"></span>' + (msg || "Loading…") + "</div>"; }
function emptyHTML(msg) { return '<div class="empty">' + msg + "</div>"; }
function escSoql(v) { return String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function apiPath(path) { return SFPE.apiBase + "/services/data/v" + SFPE.apiVersion + path; }

function toast(msg, isError) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "show" + (isError ? " error" : "");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = ""; }, 3200);
}

async function copyText(text, label) {
    try {
        await navigator.clipboard.writeText(text);
        toast((label || "Copied") + " — clipboard holds it now");
        return true;
    } catch (e) {
        toast("Clipboard blocked by the browser. Select the text and copy manually.", true);
        return false;
    }
}

function maskToken(t) {
    if (!t) return "—";
    var bang = t.indexOf("!");
    if (bang > 0) return t.slice(0, bang + 1) + "•".repeat(16);
    return t.slice(0, 4) + "•".repeat(16);
}

function openInTab(url) {
    if (typeof chrome !== "undefined" && chrome.tabs) chrome.tabs.create({ url: url });
    else window.open(url, "_blank");
}

// ── API ──────────────────────────────────────────────────────────────────────
function callApi(url, sid, method, body, contentType) {
    return new Promise(function (resolve) {
        chrome.runtime.sendMessage({
            action: "callApi",
            url: url,
            sessionId: sid || sessionId,
            method: method || "GET",
            body: body === undefined ? null : body,
            contentType: contentType || "application/json"
        }, function (r) { resolve(r || { success: false, error: "No response from background worker." }); });
    });
}

async function pagedQuery(soql, useTooling, includeDeleted) {
    var records = [];
    var resource = useTooling ? "/tooling/query?q=" : (includeDeleted ? "/queryAll?q=" : "/query?q=");
    var url = apiPath(resource) + encodeURIComponent(soql);
    while (url) {
        var res = await callApi(url);
        if (!res.success) throw new Error(res.error || "Query failed");
        records = records.concat(res.data.records || []);
        url = res.data.nextRecordsUrl ? SFPE.apiBase + res.data.nextRecordsUrl : null;
    }
    return records;
}
function toolingQuery(soql) { return pagedQuery(soql, true); }

// ── theme ────────────────────────────────────────────────────────────────────
function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    $("btnTheme").textContent = t === "dark" ? "Light" : "Dark";
    try { chrome.storage.local.set({ theme: t }); } catch (e) {}
}
$("btnTheme").addEventListener("click", function () {
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
});

// ── view switching ───────────────────────────────────────────────────────────
function showView(name) {
    document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-" + name); });
    document.querySelectorAll(".rail-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.view === name); });
    SFPE.currentView = name;
    document.dispatchEvent(new CustomEvent("sfpe:view", { detail: name }));
}
document.querySelectorAll(".rail-btn").forEach(function (b) {
    b.addEventListener("click", function () { showView(b.dataset.view); });
});
document.addEventListener("keydown", function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    var order = ["org", "cli", "perms", "access", "query", "apex", "rest", "logs", "limits", "utils"];
    var idx = e.key === "0" ? 9 : parseInt(e.key, 10) - 1;
    if (idx >= 0 && idx < order.length) { showView(order[idx]); e.preventDefault(); }
});

// ── connection ───────────────────────────────────────────────────────────────
function setStatus(state, text) {
    $("statusDot").className = "dot" + (state === "on" ? " on" : state === "err" ? " err" : "");
    $("statusText").textContent = text;
}

function listOrgs() {
    return new Promise(function (resolve) {
        chrome.runtime.sendMessage({ action: "listOrgs" }, function (r) { resolve((r && r.orgs) || []); });
    });
}

function fetchSession(origin) {
    return new Promise(function (resolve) {
        chrome.runtime.sendMessage({ action: "getSessionId", url: origin }, function (r) { resolve(r || { success: false }); });
    });
}

async function loadApiVersions() {
    var res = await callApi(SFPE.apiBase + "/services/data/");
    var sel = $("apiVersionSelect");
    sel.innerHTML = "";
    var versions = (res.success && Array.isArray(res.data)) ? res.data.map(function (v) { return v.version; }) : ["62.0", "61.0", "60.0", "59.0"];
    var latest = versions[versions.length - 1];
    versions.slice(-14).reverse().forEach(function (v) {
        var o = document.createElement("option");
        o.value = v; o.textContent = "v" + v;
        sel.appendChild(o);
    });
    var stored = await new Promise(function (r) { chrome.storage.local.get(["apiVersion"], function (d) { r(d.apiVersion); }); });
    SFPE.apiVersion = (stored && versions.indexOf(stored) !== -1) ? stored : latest;
    sel.value = SFPE.apiVersion;
    $("orgLatestApi").textContent = "v" + latest;
}
$("apiVersionSelect").addEventListener("change", function () {
    SFPE.apiVersion = $("apiVersionSelect").value;
    chrome.storage.local.set({ apiVersion: SFPE.apiVersion });
    toast("Now calling API v" + SFPE.apiVersion);
});

async function loadOrgIdentity() {
    $("orgUrl").textContent = SFPE.apiBase;

    var who = await callApi(SFPE.apiBase + "/services/oauth2/userinfo");
    if (who.success && who.data) {
        SFPE.user = {
            id: who.data.user_id,
            name: who.data.name,
            username: who.data.preferred_username || who.data.username,
            orgId: who.data.organization_id
        };
        $("orgUser").textContent = SFPE.user.name || "—";
        $("orgUsername").textContent = SFPE.user.username || "—";
        $("orgId").textContent = SFPE.user.orgId || "—";
    }

    try {
        var orgRecs = await pagedQuery("SELECT Id, Name, OrganizationType, InstanceName, IsSandbox, NamespacePrefix FROM Organization LIMIT 1");
        if (orgRecs.length) {
            var o = orgRecs[0];
            SFPE.org = { id: o.Id, name: o.Name, type: o.OrganizationType, instance: o.InstanceName, sandbox: o.IsSandbox, ns: o.NamespacePrefix };
            $("orgName").textContent = o.Name || "—";
            $("orgId").textContent = o.Id || "—";
            $("orgType").textContent = o.OrganizationType || "—";
            $("orgInstance").textContent = o.InstanceName || "—";
            $("orgEnv").textContent = o.IsSandbox ? "Sandbox" : (/Developer/i.test(o.OrganizationType || "") ? "Developer org" : "Production");
        }
    } catch (e) { /* some orgs restrict Organization access */ }

    if (SFPE.user && SFPE.user.id) {
        try {
            var u = await pagedQuery("SELECT Profile.Name, TimeZoneSidKey FROM User WHERE Id = '" + escSoql(SFPE.user.id) + "'");
            if (u.length && u[0].Profile) $("orgProfile").textContent = u[0].Profile.Name;
        } catch (e) {}
    }
}

function buildQuickLinks() {
    var L = SFPE.lightningBase;
    var links = [
        ["Setup home", "/lightning/setup/SetupOneHome/home"],
        ["Object Manager", "/lightning/setup/ObjectManager/home"],
        ["Permission sets", "/lightning/setup/PermSets/home"],
        ["Profiles", "/lightning/setup/EnhancedProfiles/home"],
        ["Users", "/lightning/setup/ManageUsers/home"],
        ["Apex classes", "/lightning/setup/ApexClasses/home"],
        ["Apex triggers", "/lightning/setup/ApexTriggers/home"],
        ["Lightning components", "/lightning/setup/LightningComponentBundles/home"],
        ["Flows", "/lightning/setup/Flows/home"],
        ["Debug logs", "/lightning/setup/ApexDebugLogs/home"],
        ["Deployment status", "/lightning/setup/DeployStatus/home"],
        ["Apex jobs", "/lightning/setup/AsyncApexJobs/home"],
        ["Scheduled jobs", "/lightning/setup/ScheduledJobs/home"],
        ["Named credentials", "/lightning/setup/NamedCredential/home"],
        ["Connected apps", "/lightning/setup/ConnectedApplication/home"],
        ["Custom labels", "/lightning/setup/ExternalStrings/home"],
        ["Custom settings", "/lightning/setup/CustomSettings/home"],
        ["Custom metadata", "/lightning/setup/CustomMetadata/home"],
        ["Developer Console", "/_ui/common/apex/debug/ApexCSIPage"],
        ["Sandbox refresh", "/lightning/setup/DataManagementCreateTestInstance/home"]
    ];
    var wrap = $("quickLinks");
    wrap.innerHTML = "";
    links.forEach(function (l) {
        var a = document.createElement("a");
        a.textContent = l[0];
        a.href = "#";
        a.addEventListener("click", function (e) {
            e.preventDefault();
            openInTab((l[1].indexOf("/lightning") === 0 ? L : SFPE.apiBase) + l[1]);
        });
        wrap.appendChild(a);
    });
}

function renderTokenCard() {
    $("tokenMasked").textContent = sessionId ? maskToken(sessionId) : "No session in this window.";
}

async function connectTo(origin, providedToken) {
    setStatus("", "Connecting…");
    SFPE.ready = false;

    if (providedToken) {
        sessionId = providedToken;
        SFPE.manual = true;
    } else {
        var s = await fetchSession(origin);
        if (!s.success) {
            setStatus("err", "No session");
            toast(s.error || "Could not read the session for that org.", true);
            return false;
        }
        sessionId = s.sessionId;
        SFPE.manual = false;
    }

    SFPE.apiBase = origin.replace(/\/+$/, "");
    currentApiBase = SFPE.apiBase;
    SFPE.lightningBase = SFPE.apiBase
        .replace(".my.salesforce.com", ".lightning.force.com")
        .replace(".salesforce.com", ".lightning.force.com");
    describeCache = {};

    await loadApiVersions();
    var probe = await callApi(apiPath("/limits"));
    if (!probe.success) {
        setStatus("err", "Session rejected");
        toast("The org refused that session: " + probe.error, true);
        renderTokenCard();
        return false;
    }

    await loadOrgIdentity();
    buildQuickLinks();
    renderTokenCard();

    var host = new URL(SFPE.apiBase).hostname;
    setStatus("on", (SFPE.org && SFPE.org.name ? SFPE.org.name : host) + (SFPE.manual ? " · pasted session" : ""));

    SFPE.ready = true;
    stashSession();
    SFPE._readyCbs.forEach(function (cb) { try { cb(); } catch (e) {} });
    document.dispatchEvent(new CustomEvent("sfpe:connected"));
    return true;
}

// ── optional "remember until the browser closes" ─────────────────────────────
// chrome.storage.session lives in browser memory, is readable by extension
// pages only, and is dropped when Chrome exits. Nothing is written to disk.
function rememberWanted() { var el = $("rememberSession"); return !!(el && el.checked); }

function stashSession() {
    if (!chrome.storage.session) return;
    if (rememberWanted() && sessionId && SFPE.apiBase) {
        chrome.storage.session.set({ live: { origin: SFPE.apiBase, token: sessionId, manual: SFPE.manual } });
    } else {
        chrome.storage.session.remove("live");
    }
}

function readStashedSession() {
    return new Promise(function (resolve) {
        if (!chrome.storage.session) return resolve(null);
        chrome.storage.session.get(["live"], function (d) { resolve(d && d.live ? d.live : null); });
    });
}

SFPE.onReady = function (cb) {
    SFPE._readyCbs.push(cb);
    if (SFPE.ready) { try { cb(); } catch (e) {} }
};

function clearSession(quiet) {
    sessionId = null;
    currentApiBase = null;
    SFPE.apiBase = null;
    SFPE.ready = false;
    describeCache = {};
    renderTokenCard();
    if (chrome.storage.session) chrome.storage.session.remove("live");
    setStatus("err", "Locked");
    if (!quiet) toast("Session forgotten. Hit Reconnect to pick it up again.");
    document.dispatchEvent(new CustomEvent("sfpe:locked"));
}
$("btnClearSession").addEventListener("click", function () { clearSession(); });

// ── org picker ───────────────────────────────────────────────────────────────
async function refreshOrgList(autoConnect) {
    var orgs = await listOrgs();
    var sel = $("orgSelect");
    sel.innerHTML = "";

    if (!orgs.length) {
        var o = document.createElement("option");
        o.textContent = "No Salesforce tab open";
        sel.appendChild(o);
        setStatus("err", "No org detected");
        return orgs;
    }

    orgs.forEach(function (org) {
        var opt = document.createElement("option");
        opt.value = org.origin;
        opt.textContent = org.host + (org.hasSession ? "" : "  (no session)");
        sel.appendChild(opt);
    });

    var preferred = orgs.find(function (o) { return o.hasSession; }) || orgs[0];
    sel.value = preferred.origin;
    if (autoConnect) await connectTo(preferred.origin);
    return orgs;
}

$("orgSelect").addEventListener("change", function () {
    var origin = $("orgSelect").value;
    if (origin && origin.indexOf("https://") === 0) connectTo(origin);
});
$("btnReconnect").addEventListener("click", async function () {
    var origin = $("orgSelect").value;
    await refreshOrgList(false);
    await connectTo(origin && origin.indexOf("https://") === 0 ? origin : $("orgSelect").value);
});

// ── token card actions ───────────────────────────────────────────────────────
var revealTimer = null;
function revealFor(el, text, seconds, btn) {
    clearTimeout(revealTimer);
    el.textContent = text;
    if (btn) btn.textContent = "Hide";
    revealTimer = setTimeout(function () {
        el.textContent = maskToken(sessionId);
        if (btn) btn.textContent = "Reveal 15s";
    }, (seconds || 15) * 1000);
}
$("btnRevealToken").addEventListener("click", function () {
    if (!sessionId) { toast("Nothing to reveal — connect first.", true); return; }
    var el = $("tokenMasked"), btn = $("btnRevealToken");
    if (btn.textContent === "Hide") {
        clearTimeout(revealTimer); el.textContent = maskToken(sessionId); btn.textContent = "Reveal 15s"; return;
    }
    revealFor(el, sessionId, 15, btn);
});
$("btnCopyToken").addEventListener("click", function () {
    if (!sessionId) { toast("Connect to an org first.", true); return; }
    copyText(sessionId, "Session token copied");
});
$("btnCopyInstance").addEventListener("click", function () {
    if (!SFPE.apiBase) { toast("Connect to an org first.", true); return; }
    copyText(SFPE.apiBase, "Instance url copied");
});
$("btnCopyFrontdoor").addEventListener("click", function () {
    if (!sessionId) { toast("Connect to an org first.", true); return; }
    copyText(SFPE.apiBase + "/secur/frontdoor.jsp?sid=" + sessionId, "Login link copied — it carries your token, share it with nobody");
});
function wipeClipboard() {
    navigator.clipboard.writeText(" ").then(function () { toast("Clipboard overwritten."); })
        .catch(function () { toast("Could not touch the clipboard.", true); });
}
$("btnClearClipboard").addEventListener("click", wipeClipboard);

$("rememberSession").addEventListener("change", function () {
    chrome.storage.local.set({ remember: $("rememberSession").checked });
    stashSession();
    toast($("rememberSession").checked
        ? "Session kept in browser memory until Chrome closes."
        : "Session will be dropped as soon as this window closes.");
});

$("btnUseManual").addEventListener("click", async function () {
    var url = $("manualInstance").value.trim().replace(/\/+$/, "");
    var tok = $("manualToken").value.trim();
    if (!/^https:\/\/[\w.-]+\.(salesforce|force)\.com$/i.test(url)) {
        toast("Instance url should look like https://mydomain.my.salesforce.com", true); return;
    }
    if (!tok) { toast("Paste the session id too.", true); return; }
    var ok = await connectTo(url, tok);
    $("manualToken").value = "";
    if (ok) toast("Connected with the pasted session.");
});

$("btnCopyOrgInfo").addEventListener("click", function () {
    if (!SFPE.apiBase) { toast("Connect to an org first.", true); return; }
    var lines = [
        "Org:        " + (SFPE.org ? SFPE.org.name : "—"),
        "Org id:     " + (SFPE.org ? SFPE.org.id : "—"),
        "Edition:    " + (SFPE.org ? SFPE.org.type : "—"),
        "Instance:   " + (SFPE.org ? SFPE.org.instance : "—"),
        "Instance url: " + SFPE.apiBase,
        "User:       " + (SFPE.user ? SFPE.user.name + " <" + SFPE.user.username + ">" : "—"),
        "API:        v" + SFPE.apiVersion
    ];
    copyText(lines.join("\n"), "Org summary copied");
});

// ── export helpers (shared by every module) ──────────────────────────────────
function downloadCSVFromRows(rows, filename) {
    if (!rows || !rows.length) { toast("Nothing to export.", true); return; }
    var headers = Object.keys(rows[0]);
    var lines = [headers.map(csvCell).join(",")];
    rows.forEach(function (r) { lines.push(headers.map(function (h) { return csvCell(r[h]); }).join(",")); });
    saveBlob(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), filename);
    toast("Exported " + rows.length + " rows");
}
function csvCell(v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }

function exportXLS(rows, filename, sheetName) {
    if (!rows || !rows.length) { toast("Nothing to export.", true); return; }
    var headers = Object.keys(rows[0]);
    var all = [headers].concat(rows.map(function (r) { return headers.map(function (h) { return r[h]; }); }));
    var xml = '<?xml version="1.0"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
        'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="' + (sheetName || "Sheet1") + '"><Table>' +
        all.map(function (row) {
            return "<Row>" + row.map(function (c) {
                var s = String(c == null ? "" : c).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                return '<Cell><Data ss:Type="String">' + s + "</Data></Cell>";
            }).join("") + "</Row>";
        }).join("") + "</Table></Worksheet></Workbook>";
    saveBlob(new Blob([xml], { type: "application/vnd.ms-excel" }), filename);
    toast("Exported " + rows.length + " rows");
}

function saveBlob(blob, filename) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
}

function rowsToTSV(rows) {
    if (!rows.length) return "";
    var headers = Object.keys(rows[0]);
    return [headers.join("\t")].concat(rows.map(function (r) {
        return headers.map(function (h) { return String(r[h] == null ? "" : r[h]).replace(/[\t\n]/g, " "); }).join("\t");
    })).join("\n");
}

// ── generic table renderer used by SOQL + limits ─────────────────────────────
function renderTable(container, rows, columns) {
    container.innerHTML = "";
    if (!rows.length) { container.innerHTML = emptyHTML("No rows."); return; }
    var cols = columns || Object.keys(rows[0]);
    var table = document.createElement("table");
    table.className = "ua-table";
    var thead = document.createElement("thead"), hr = document.createElement("tr");
    cols.forEach(function (c) { var th = document.createElement("th"); th.textContent = c; hr.appendChild(th); });
    thead.appendChild(hr); table.appendChild(thead);
    var tb = document.createElement("tbody");
    rows.forEach(function (r) {
        var tr = document.createElement("tr");
        cols.forEach(function (c) {
            var td = document.createElement("td");
            var v = r[c];
            td.textContent = (v === null || v === undefined) ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
            tr.appendChild(td);
        });
        tb.appendChild(tr);
    });
    table.appendChild(tb);
    container.appendChild(table);
}
