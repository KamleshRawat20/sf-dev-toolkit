// =============================================================================
// useraccess.js — "what can this user actually see?"
//
// FieldPermissions.ParentId always points at a PermissionSet, even for a
// profile: each profile owns a hidden permission set (IsOwnedByProfile = true).
// So a user's effective access is the OR of their profile-owned set plus every
// permission set assigned to them — which is exactly what this builds.
// =============================================================================

var uaAllUsers = [], uaFilteredUsers = [], uaSelectedUsers = new Set();
var uaFilteredObjs = [], uaSelectedObjs = new Set();
var uaLastRows = [];

function uaRenderObjects() {
    if (!allObjects.length) {
        $("uaObjList").innerHTML = emptyHTML("Objects load once you're connected.");
        return;
    }
    var q = $("uaObjSearch").value.trim();
    uaFilteredObjs = q ? allObjects.filter(function (o) { return matches(o.label, q) || matches(o.name, q); }) : allObjects.slice();
    $("uaObjCount").textContent = allObjects.length;
    var host = $("uaObjList");
    host.innerHTML = "";
    if (!uaFilteredObjs.length) { host.innerHTML = emptyHTML("Nothing matches."); return; }
    var frag = document.createDocumentFragment();
    uaFilteredObjs.forEach(function (obj) {
        frag.appendChild(listRow(obj.label || obj.name, obj.name, uaSelectedObjs.has(obj.name), function (on) {
            if (on) uaSelectedObjs.add(obj.name); else uaSelectedObjs.delete(obj.name);
        }));
    });
    host.appendChild(frag);
}

function uaRenderUserList() {
    var host = $("uaUserList");
    host.innerHTML = "";
    if (!uaFilteredUsers.length) { host.innerHTML = emptyHTML("No users yet — search above."); return; }
    var frag = document.createDocumentFragment();
    uaFilteredUsers.forEach(function (u) {
        frag.appendChild(listRow(u.name, u.username + " · " + u.profileName, uaSelectedUsers.has(u.id), function (on) {
            if (on) uaSelectedUsers.add(u.id); else uaSelectedUsers.delete(u.id);
        }));
    });
    host.appendChild(frag);
}

async function uaSearchUsers() {
    if (!SFPE.ready) { toast("Connect to an org first.", true); return; }
    var q = $("uaUserSearch").value.trim();
    $("uaUserList").innerHTML = loadingHTML("Searching users…");
    try {
        var soql = "SELECT Id, Name, Username, ProfileId, Profile.Name FROM User WHERE IsActive = true";
        if (q) soql += " AND (Name LIKE '%" + escSoql(q) + "%' OR Username LIKE '%" + escSoql(q) + "%')";
        soql += " ORDER BY Name LIMIT 200";
        var recs = await pagedQuery(soql);
        uaAllUsers = recs.map(function (r) {
            if (r.ProfileId && r.Profile) profileNameCache[r.ProfileId] = r.Profile.Name;
            return { id: r.Id, name: r.Name, username: r.Username, profileId: r.ProfileId, profileName: (r.Profile && r.Profile.Name) || "" };
        });
        uaFilteredUsers = uaAllUsers.slice();
        $("uaUserCount").textContent = uaAllUsers.length;
        uaRenderUserList();
    } catch (err) {
        $("uaUserList").innerHTML = emptyHTML("Search failed: " + err.message);
    }
}

async function uaFetchAccess() {
    if (!uaSelectedUsers.size) { toast("Pick at least one user.", true); return; }
    if (!uaSelectedObjs.size) { toast("Pick at least one object.", true); return; }

    $("uaResultArea").innerHTML = loadingHTML("Combining profile and permission set grants…");
    $("uaHint").textContent = "Working…";
    $("uaDlCsvBtn").hidden = $("uaDlXlsxBtn").hidden = true;

    try {
        var userIds = Array.from(uaSelectedUsers);
        var objNames = Array.from(uaSelectedObjs);
        var userMap = {}; uaAllUsers.forEach(function (u) { userMap[u.id] = u; });

        // 1. profile + assigned permission sets per user
        var userInfo = {};
        for (var ui = 0; ui < userIds.length; ui += 100) {
            var chunk = userIds.slice(ui, ui + 100).map(function (id) { return "'" + escSoql(id) + "'"; }).join(",");
            (await pagedQuery("SELECT Id, ProfileId FROM User WHERE Id IN (" + chunk + ")"))
                .forEach(function (r) { userInfo[r.Id] = { profileId: r.ProfileId, permsetIds: [] }; });
            (await pagedQuery("SELECT AssigneeId, PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId IN (" + chunk + ") AND PermissionSet.IsOwnedByProfile = false"))
                .forEach(function (r) { if (userInfo[r.AssigneeId]) userInfo[r.AssigneeId].permsetIds.push(r.PermissionSetId); });
        }

        // 2. profile → its hidden permission set
        var profileIds = [], profileToSet = {}, nameMap = {};
        Object.keys(userInfo).forEach(function (uid) {
            var p = userInfo[uid].profileId;
            if (p && profileIds.indexOf(p) === -1) profileIds.push(p);
        });
        for (var pi = 0; pi < profileIds.length; pi += 100) {
            var pc = profileIds.slice(pi, pi + 100).map(function (id) { return "'" + escSoql(id) + "'"; }).join(",");
            (await pagedQuery("SELECT Id, ProfileId, Profile.Name FROM PermissionSet WHERE IsOwnedByProfile = true AND ProfileId IN (" + pc + ")"))
                .forEach(function (r) {
                    profileToSet[r.ProfileId] = r.Id;
                    var n = (r.Profile && r.Profile.Name) || profileNameCache[r.ProfileId] || r.ProfileId;
                    nameMap[r.Id] = n + " (profile)";
                    profileNameCache[r.ProfileId] = n;
                });
        }

        // 3. labels for assigned permission sets
        var setIds = [];
        Object.keys(userInfo).forEach(function (uid) {
            userInfo[uid].permsetIds.forEach(function (id) { if (setIds.indexOf(id) === -1) setIds.push(id); });
        });
        for (var si = 0; si < setIds.length; si += 100) {
            var sc = setIds.slice(si, si + 100).map(function (id) { return "'" + escSoql(id) + "'"; }).join(",");
            try {
                (await pagedQuery("SELECT Id, Label, Name FROM PermissionSet WHERE Id IN (" + sc + ")"))
                    .forEach(function (r) { nameMap[r.Id] = (r.Label || r.Name) + " (perm set)"; });
            } catch (e) {}
        }

        // 4. parent list per user
        var parentsByUser = {};
        userIds.forEach(function (uid) {
            var info = userInfo[uid];
            var list = [];
            if (info) {
                var ps = info.profileId ? profileToSet[info.profileId] : null;
                if (ps) list.push({ id: ps, name: nameMap[ps] || "profile", isProfile: true });
                info.permsetIds.forEach(function (id) { list.push({ id: id, name: nameMap[id] || id, isProfile: false }); });
            }
            parentsByUser[uid] = list;
        });

        // 5. describe every selected object
        var objFields = {};
        await Promise.all(objNames.map(function (name) {
            if (describeCache[name]) { objFields[name] = describeCache[name]; return Promise.resolve(); }
            return callApi(apiPath("/sobjects/" + name + "/describe")).then(function (res) {
                if (res.success) { describeCache[name] = res.data.fields || []; objFields[name] = describeCache[name]; }
            }).catch(function () {});
        }));

        var allParentIds = [];
        userIds.forEach(function (uid) {
            (parentsByUser[uid] || []).forEach(function (p) { if (allParentIds.indexOf(p.id) === -1) allParentIds.push(p.id); });
        });
        if (!allParentIds.length) {
            $("uaResultArea").innerHTML = emptyHTML("Those users have no profile or permission sets the API can read.");
            $("uaHint").textContent = "Nothing to show.";
            return;
        }

        var fieldKeys = [];
        objNames.forEach(function (o) { (objFields[o] || []).forEach(function (f) { fieldKeys.push(o + "." + f.name); }); });
        if (!fieldKeys.length) {
            $("uaResultArea").innerHTML = emptyHTML("Could not describe those objects.");
            $("uaHint").textContent = "Nothing to show.";
            return;
        }

        // 6. field permissions for those parents
        var fp = {};
        for (var fi = 0; fi < fieldKeys.length; fi += 300) {
            var fClause = fieldKeys.slice(fi, fi + 300).map(function (k) { return "'" + escSoql(k) + "'"; }).join(",");
            for (var qi = 0; qi < allParentIds.length; qi += 150) {
                var pClause = allParentIds.slice(qi, qi + 150).map(function (id) { return "'" + escSoql(id) + "'"; }).join(",");
                try {
                    (await pagedQuery("SELECT Field, ParentId, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE Field IN (" + fClause + ") AND ParentId IN (" + pClause + ")"))
                        .forEach(function (r) { fp[r.ParentId + "|" + r.Field] = { read: r.PermissionsRead, edit: r.PermissionsEdit }; });
                } catch (e) {}
            }
        }

        // 7. flatten
        var rows = [];
        userIds.forEach(function (uid) {
            var user = userMap[uid];
            if (!user) return;
            var parents = parentsByUser[uid] || [];
            objNames.forEach(function (objName) {
                var meta = allObjects.find(function (o) { return o.name === objName; });
                var objLabel = meta ? (meta.label || objName) : objName;
                (objFields[objName] || []).forEach(function (field) {
                    var key = objName + "." + field.name;
                    var readSrc = [], editSrc = [];
                    parents.forEach(function (p) {
                        var g = fp[p.id + "|" + key];
                        if (!g) return;
                        if (g.read) readSrc.push(p.name);
                        if (g.edit) editSrc.push(p.name);
                    });
                    rows.push({
                        "User": user.name,
                        "Username": user.username,
                        "Profile": user.profileName,
                        "Object": objLabel,
                        "Object api": objName,
                        "Field": field.label || field.name,
                        "Field api": field.name,
                        "Type": field.type || "",
                        "Read": readSrc.length ? "Yes" : "No",
                        "Edit": editSrc.length ? "Yes" : "No",
                        "Createable": field.createable ? "Yes" : "No",
                        "Read granted by": readSrc.join("; ") || "—",
                        "Edit granted by": editSrc.join("; ") || "—"
                    });
                });
            });
        });

        uaLastRows = rows;
        uaRenderResultTable(rows);
        $("uaHint").textContent = rows.length + " rows · " + userIds.length + " user(s) · " + objNames.length + " object(s)";
        $("uaDlCsvBtn").hidden = $("uaDlXlsxBtn").hidden = false;
    } catch (err) {
        $("uaResultArea").innerHTML = emptyHTML("Fetch failed: " + err.message);
        $("uaHint").textContent = "Failed.";
    }
}

function uaRenderResultTable(rows) {
    var host = $("uaResultArea");
    host.innerHTML = "";
    if (!rows.length) { host.innerHTML = emptyHTML("No rows."); return; }

    var headers = ["User", "Username", "Profile", "Object", "Object api", "Field", "Field api", "Type", "Read", "Edit", "Createable", "Read granted by", "Edit granted by"];
    var badgeCols = { Read: 1, Edit: 1, Createable: 1 };

    var table = document.createElement("table"); table.className = "ua-table";
    var thead = document.createElement("thead"), hr = document.createElement("tr");
    headers.forEach(function (h) { var th = document.createElement("th"); th.textContent = h; hr.appendChild(th); });
    thead.appendChild(hr); table.appendChild(thead);

    var tbody = document.createElement("tbody");
    var prev = null;
    rows.forEach(function (row) {
        var key = row.User + "|" + row["Object api"];
        if (key !== prev) {
            var sec = document.createElement("tr"); sec.className = "ua-section-row";
            var td = document.createElement("td"); td.colSpan = headers.length;
            td.textContent = row.User + "  ·  " + row.Object + " (" + row["Object api"] + ")";
            sec.appendChild(td); tbody.appendChild(sec);
            prev = key;
        }
        var tr = document.createElement("tr");
        headers.forEach(function (h) {
            var td = document.createElement("td");
            var v = row[h] == null ? "" : String(row[h]);
            if (badgeCols[h]) {
                var b = document.createElement("span");
                b.className = "badge " + (v === "Yes" ? "badge-yes" : "badge-no");
                b.textContent = v;
                td.appendChild(b);
            } else if (h.indexOf("granted by") !== -1 && v !== "—") {
                td.style.maxWidth = "230px";
                v.split("; ").forEach(function (src) {
                    var chip = document.createElement("span");
                    chip.className = "chip" + (src.indexOf("(profile)") !== -1 ? " profile" : "");
                    chip.textContent = src;
                    td.appendChild(chip);
                });
            } else td.textContent = v;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
}

// ── wiring ───────────────────────────────────────────────────────────────────
$("uaSearchUsersBtn").addEventListener("click", uaSearchUsers);
$("uaUserSearch").addEventListener("keydown", function (e) { if (e.key === "Enter") uaSearchUsers(); });
$("uaSelAllUsers").addEventListener("click", function () {
    uaFilteredUsers.forEach(function (u) { uaSelectedUsers.add(u.id); }); uaRenderUserList();
});
$("uaDeselAllUsers").addEventListener("click", function () { uaSelectedUsers.clear(); uaRenderUserList(); });

var uaObjTimer;
$("uaObjSearch").addEventListener("input", function () { clearTimeout(uaObjTimer); uaObjTimer = setTimeout(uaRenderObjects, 120); });
$("uaSelAllObjs").addEventListener("click", function () {
    uaFilteredObjs.slice(0, 10).forEach(function (o) { uaSelectedObjs.add(o.name); });
    if (uaFilteredObjs.length > 10) toast("Selected the first 10 objects — field-level checks across more get very slow.");
    uaRenderObjects();
});
$("uaDeselAllObjs").addEventListener("click", function () { uaSelectedObjs.clear(); uaRenderObjects(); });
$("uaFetchBtn").addEventListener("click", uaFetchAccess);
$("uaDlCsvBtn").addEventListener("click", function () { downloadCSVFromRows(uaLastRows, "user_field_access.csv"); });
$("uaDlXlsxBtn").addEventListener("click", function () { exportXLS(uaLastRows, "user_field_access.xls", "User field access"); });

document.addEventListener("sfpe:view", function (e) { if (e.detail === "access") uaRenderObjects(); });
