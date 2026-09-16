// =============================================================================
// permissions.js — object, field, component and system permission explorer.
// Read and write: every table row can be toggled and saved back to the org.
// =============================================================================

var allObjects = [], filteredObjects = [];
var allFields = [], filteredFields = [];
var selectedObjNames = new Set(), selectedFields = new Set();
var allCompItems = [], filteredCompItems = [], selectedCompItems = new Set();
var lastPermData = [], lastObjPermData = [], lastCompPermData = [];
var profileNameCache = {};
var currentCompType = "objects";
var activeObjTab = "fields";
var validSysPermFields = null;

var COMP_CONFIG = {
    apexclass:    { label: "Apex classes",       mode: "setupentity", itemSoql: "SELECT Id, Name FROM ApexClass ORDER BY Name", nameField: "Name", labelField: "Name" },
    apexpage:     { label: "Visualforce pages",  mode: "setupentity", itemSoql: "SELECT Id, Name FROM ApexPage ORDER BY Name", nameField: "Name", labelField: "Name" },
    lwc:          { label: "Lightning web components", mode: "setupentity", useTooling: true, itemSoql: "SELECT Id, DeveloperName, MasterLabel FROM LightningComponentBundle ORDER BY MasterLabel", nameField: "DeveloperName", labelField: "MasterLabel" },
    aura:         { label: "Aura components",    mode: "setupentity", useTooling: true, itemSoql: "SELECT Id, DeveloperName, MasterLabel FROM AuraDefinitionBundle ORDER BY MasterLabel", nameField: "DeveloperName", labelField: "MasterLabel" },
    flow:         { label: "Flows",              mode: "flow", itemSoql: "SELECT DurableId, ApiName, Label, ActiveVersionId FROM FlowDefinitionView WHERE IsActive = true ORDER BY Label", idField: "DurableId", nameField: "ApiName", labelField: "Label" },
    customapp:    { label: "Custom apps",        mode: "setupentity", itemSoql: "SELECT Id, DeveloperName, Label FROM AppDefinition ORDER BY Label", nameField: "DeveloperName", labelField: "Label" },
    tab:          { label: "Tabs",               mode: "tab", itemSoql: "SELECT Id, Name, Label FROM TabDefinition ORDER BY Label", nameField: "Name", labelField: "Label" },
    connectedapp: { label: "Connected apps",     mode: "setupentity", itemSoql: "SELECT Id, Name FROM ConnectedApplication ORDER BY Name", nameField: "Name", labelField: "Name" },
    customperm:   { label: "Custom permissions", mode: "setupentity", itemSoql: "SELECT Id, DeveloperName, MasterLabel FROM CustomPermission ORDER BY MasterLabel", nameField: "DeveloperName", labelField: "MasterLabel" },
    recordtype:   { label: "Record types",       mode: "recordtype", itemSoql: "SELECT Id, Name, DeveloperName, SobjectType FROM RecordType ORDER BY SobjectType, Name", nameField: "DeveloperName", labelField: "Name" },
    sysperm:      { label: "System permissions", mode: "sysperm" }
};

var SYS_PERM_FIELDS = [
    { api: "PermissionsModifyAllData", label: "Modify All Data" },
    { api: "PermissionsViewAllData", label: "View All Data" },
    { api: "PermissionsCustomizeApplication", label: "Customize Application" },
    { api: "PermissionsAuthorApex", label: "Author Apex" },
    { api: "PermissionsRunReports", label: "Run Reports" },
    { api: "PermissionsDataImport", label: "Import Wizard" },
    { api: "PermissionsApiEnabled", label: "API Enabled" },
    { api: "PermissionsViewSetup", label: "View Setup" },
    { api: "PermissionsManageUsers", label: "Manage Users" },
    { api: "PermissionsResetPasswords", label: "Reset Passwords" },
    { api: "PermissionsAssignPermissionSets", label: "Assign Perm Sets" },
    { api: "PermissionsManageRoles", label: "Manage Roles" },
    { api: "PermissionsManageIpAddresses", label: "Manage IP Addresses" },
    { api: "PermissionsSendEmail", label: "Send Email" },
    { api: "PermissionsMassInlineEdit", label: "Mass Inline Edit" },
    { api: "PermissionsManageFlows", label: "Manage Flows" },
    { api: "PermissionsRunFlow", label: "Run Flows" },
    { api: "PermissionsViewAllUsers", label: "View All Users" },
    { api: "PermissionsCreateCustomizeReports", label: "Create/Customize Reports" },
    { api: "PermissionsEditReports", label: "Edit Reports" },
    { api: "PermissionsManageDashboards", label: "Manage Dashboards" },
    { api: "PermissionsCreateDashboards", label: "Create Dashboards" },
    { api: "PermissionsEditMyDashboards", label: "Edit My Dashboards" },
    { api: "PermissionsDeleteDashboards", label: "Delete Dashboards" }
];

// ── small builders ───────────────────────────────────────────────────────────
function makeToggle(checked, disabled) {
    var lbl = document.createElement("label"); lbl.className = "toggle";
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!checked; cb.disabled = !!disabled;
    var track = document.createElement("span"); track.className = "track";
    lbl.appendChild(cb); lbl.appendChild(track);
    return { label: lbl, cb: cb };
}
function makeTypeTag(isProfile) {
    var s = document.createElement("span");
    s.className = "type-tag " + (isProfile ? "type-profile" : "type-permset");
    s.textContent = isProfile ? "Profile" : "Perm set";
    return s;
}
function makeNameCell(text) {
    var td = document.createElement("td");
    td.className = "name-cell";
    td.textContent = text || "";
    return td;
}
function makeSaveBtn(fn) {
    var b = document.createElement("button");
    b.className = "btn mini";
    b.textContent = "Save";
    if (fn) b.addEventListener("click", fn);
    return b;
}
function flashSaved(btn) {
    btn.textContent = "Saved";
    btn.style.color = "var(--ok)";
    setTimeout(function () { btn.textContent = "Save"; btn.style.color = ""; btn.disabled = false; }, 1600);
}
function looksLikeId(s) { return /^[a-zA-Z0-9]{15}$/.test(s) || /^[a-zA-Z0-9]{18}$/.test(s); }
function getParentDisplayName(parentId, parentObj, isProfile) {
    if (parentObj) {
        var n = parentObj.Label || parentObj.Name;
        if (n && !looksLikeId(n)) return n;
    }
    if (parentId && profileNameCache[parentId]) return profileNameCache[parentId];
    return (parentObj && (parentObj.Label || parentObj.Name)) || parentId || "";
}
async function resolveProfileNames(ids) {
    var needed = ids.filter(function (id) { return id && !profileNameCache[id]; });
    for (var i = 0; i < needed.length; i += 100) {
        var chunk = needed.slice(i, i + 100).map(function (id) { return "'" + escSoql(id) + "'"; }).join(",");
        try {
            var recs = await pagedQuery("SELECT Id, Name FROM Profile WHERE Id IN (" + chunk + ")");
            recs.forEach(function (r) { profileNameCache[r.Id] = r.Name; });
        } catch (e) {}
    }
    return profileNameCache;
}
async function discoverValidSysPermFields() {
    if (validSysPermFields) return validSysPermFields;
    try {
        var res = await callApi(apiPath("/sobjects/PermissionSet/describe"));
        if (!res.success) { validSysPermFields = SYS_PERM_FIELDS; return validSysPermFields; }
        var names = new Set((res.data.fields || []).map(function (f) { return f.name; }));
        validSysPermFields = SYS_PERM_FIELDS.filter(function (f) { return names.has(f.api); });
    } catch (e) { validSysPermFields = SYS_PERM_FIELDS; }
    return validSysPermFields;
}
function updateFieldCount() {
    var n = selectedFields.size;
    $("selectedCount").textContent = n + " selected";
    $("selectedCount").className = "pill" + (n ? " on" : "");
}
function setLeftLabel(text, count) {
    $("leftPanelLabel").innerHTML = count === null || count === undefined
        ? text
        : text + ' <span class="pill">' + count + "</span>";
}

// ── objects ──────────────────────────────────────────────────────────────────
async function loadObjects() {
    $("leftItemList").innerHTML = loadingHTML("Loading objects…");
    try {
        var res = await callApi(apiPath("/sobjects/"));
        if (!res.success) { $("leftItemList").innerHTML = emptyHTML("Could not list objects: " + res.error); return; }
        allObjects = (res.data.sobjects || [])
            .filter(function (o) { return o.queryable; })
            .sort(function (a, b) { return (a.label || a.name).localeCompare(b.label || b.name); });
        setLeftLabel("Objects", allObjects.length);
        applyLeftFilter();
    } catch (err) {
        $("leftItemList").innerHTML = emptyHTML("Could not list objects: " + err.message);
    }
}

async function loadComponentItems(type) {
    var cfg = COMP_CONFIG[type];
    if (!cfg) return;
    if (cfg.mode === "sysperm") {
        allCompItems = [{ id: "__sysperm__", name: "All profiles and permission sets", label: "All profiles and permission sets" }];
        filteredCompItems = allCompItems.slice();
        setLeftLabel(cfg.label, null);
        renderLeftCompItems(filteredCompItems);
        return;
    }
    $("leftItemList").innerHTML = loadingHTML("Loading " + cfg.label.toLowerCase() + "…");
    try {
        var records = cfg.useTooling ? await toolingQuery(cfg.itemSoql) : await pagedQuery(cfg.itemSoql);
        var idF = cfg.idField || "Id", nameF = cfg.nameField || "Name", labelF = cfg.labelField || "Name";
        allCompItems = records.map(function (r) {
            return {
                id: r[idF] || r.Id, name: r[nameF] || r.Id, label: r[labelF] || r[nameF] || r.Id,
                obj: r.SobjectType || null, activeVersionId: r.ActiveVersionId || null
            };
        }).sort(function (a, b) { return a.label.localeCompare(b.label); });
        setLeftLabel(cfg.label, allCompItems.length);
        applyLeftFilter();
    } catch (err) {
        $("leftItemList").innerHTML = emptyHTML("Could not load " + cfg.label + ": " + err.message);
    }
}

function applyLeftFilter() {
    var q = $("leftSearch").value.trim();
    var customOnly = $("customOnlyChk").checked;
    if (currentCompType === "objects") {
        filteredObjects = allObjects.filter(function (o) {
            if (customOnly && !o.custom) return false;
            return matches(o.label, q) || matches(o.name, q);
        });
        renderLeftObjects(filteredObjects);
    } else {
        filteredCompItems = allCompItems.filter(function (i) { return matches(i.label, q) || matches(i.name, q); });
        renderLeftCompItems(filteredCompItems);
    }
}

function listRow(label, api, checked, onToggle) {
    var div = document.createElement("div");
    div.className = "list-item" + (checked ? " selected" : "");
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = checked;
    var content = document.createElement("div"); content.className = "item-content";
    var l = document.createElement("div"); l.className = "item-label"; l.textContent = label;
    var a = document.createElement("div"); a.className = "item-api"; a.textContent = api;
    content.appendChild(l); content.appendChild(a);
    div.appendChild(cb); div.appendChild(content);
    cb.addEventListener("change", function (e) { e.stopPropagation(); div.classList.toggle("selected", cb.checked); onToggle(cb.checked); });
    div.addEventListener("click", function (e) { if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); } });
    return div;
}

function renderLeftObjects(data) {
    var host = $("leftItemList");
    host.innerHTML = "";
    if (!data.length) { host.innerHTML = emptyHTML("Nothing matches that filter."); return; }
    var frag = document.createDocumentFragment();
    data.forEach(function (obj) {
        frag.appendChild(listRow(obj.label || obj.name, obj.name, selectedObjNames.has(obj.name), function (on) {
            toggleObject(obj, on);
        }));
    });
    host.appendChild(frag);
}

function renderLeftCompItems(data) {
    var host = $("leftItemList");
    host.innerHTML = "";
    if (!data.length) { host.innerHTML = emptyHTML("Nothing matches that filter."); return; }
    var frag = document.createDocumentFragment();
    data.forEach(function (item) {
        frag.appendChild(listRow(item.label, item.name + (item.obj ? " (" + item.obj + ")" : ""), selectedCompItems.has(item.id), function (on) {
            if (on) selectedCompItems.add(item.id); else selectedCompItems.delete(item.id);
        }));
    });
    host.appendChild(frag);
}

async function toggleObject(obj, checked) {
    if (checked) selectedObjNames.add(obj.name);
    else {
        selectedObjNames.delete(obj.name);
        Array.from(selectedFields).forEach(function (k) { if (k.indexOf(obj.name + ".") === 0) selectedFields.delete(k); });
    }
    await reloadAllFields();
}

async function reloadAllFields() {
    if (!selectedObjNames.size) {
        allFields = []; filteredFields = [];
        $("fieldList").innerHTML = emptyHTML("Tick an object to load its fields.");
        updateFieldCount();
        return;
    }
    $("fieldList").innerHTML = loadingHTML("Describing objects…");
    var names = Array.from(selectedObjNames);
    var results = await Promise.all(names.map(function (objName) {
        if (describeCache[objName]) {
            return Promise.resolve(describeCache[objName].map(function (f) {
                return Object.assign({}, f, { _objectName: objName, _uniqueKey: objName + "." + f.name });
            }));
        }
        return callApi(apiPath("/sobjects/" + objName + "/describe")).then(function (res) {
            if (!res.success) return [];
            describeCache[objName] = res.data.fields || [];
            return describeCache[objName].map(function (f) {
                return Object.assign({}, f, { _objectName: objName, _uniqueKey: objName + "." + f.name });
            });
        }).catch(function () { return []; });
    }));
    allFields = [].concat.apply([], results).sort(function (a, b) { return (a.label || a.name).localeCompare(b.label || b.name); });
    var valid = new Set(allFields.map(function (f) { return f._uniqueKey; }));
    Array.from(selectedFields).forEach(function (k) { if (!valid.has(k)) selectedFields.delete(k); });
    filterFields();
    updateFieldCount();
}

function filterFields() {
    var q = $("fieldSearch").value.trim();
    filteredFields = q ? allFields.filter(function (f) { return matches(f.label, q) || matches(f.name, q); }) : allFields.slice();
    renderFields(filteredFields);
}

function renderFields(fields) {
    var host = $("fieldList");
    host.innerHTML = "";
    if (!fields.length) { host.innerHTML = emptyHTML("No fields match."); return; }
    var multi = selectedObjNames.size > 1;
    var grouped = {}, order = [];
    fields.forEach(function (f) {
        if (!grouped[f._objectName]) { grouped[f._objectName] = []; order.push(f._objectName); }
        grouped[f._objectName].push(f);
    });
    var frag = document.createDocumentFragment();
    order.forEach(function (objName) {
        if (multi) {
            var d = document.createElement("div"); d.className = "section-divider"; d.textContent = objName; frag.appendChild(d);
        }
        grouped[objName].forEach(function (f) {
            frag.appendChild(listRow(
                f.label || f.name,
                f.name + " · " + (f.type || "") + (f.nillable === false ? " · required" : ""),
                selectedFields.has(f._uniqueKey),
                function (on) { if (on) selectedFields.add(f._uniqueKey); else selectedFields.delete(f._uniqueKey); updateFieldCount(); }
            ));
        });
    });
    host.appendChild(frag);
}

// ── field-level security ─────────────────────────────────────────────────────
async function loadFieldPermissions() {
    if (!selectedObjNames.size) { toast("Pick an object first.", true); return; }
    if (!selectedFields.size) { toast("Pick at least one field.", true); return; }
    $("permList").innerHTML = loadingHTML("Reading field permissions…");
    $("permHint").textContent = "Fetching…";
    ["downloadCsvBtn", "downloadXlsxBtn", "copyTableBtn"].forEach(function (id) { $(id).hidden = true; });

    var keys = Array.from(selectedFields);
    try {
        var all = [];
        for (var i = 0; i < keys.length; i += 500) {
            var inClause = keys.slice(i, i + 500).map(function (k) { return "'" + escSoql(k) + "'"; }).join(",");
            all = all.concat(await pagedQuery(
                "SELECT Id, Field, PermissionsRead, PermissionsEdit, ParentId, Parent.Name, Parent.Label, Parent.IsOwnedByProfile " +
                "FROM FieldPermissions WHERE Field IN (" + inClause + ")"));
        }
        await resolveProfileNames(all.filter(function (r) { return r.Parent && r.Parent.IsOwnedByProfile; }).map(function (r) { return r.ParentId; }));
        lastPermData = buildPermData(all, keys);
        renderFieldPermissions(lastPermData);
        var total = lastPermData.reduce(function (s, f) { return s + f.perms.length; }, 0);
        $("permHint").textContent = lastPermData.length + " field(s), " + total + " grants";
        ["downloadCsvBtn", "downloadXlsxBtn", "copyTableBtn"].forEach(function (id) { $(id).hidden = false; });
    } catch (err) {
        $("permList").innerHTML = emptyHTML("Could not read permissions: " + err.message);
        $("permHint").textContent = "Failed.";
    }
}

function buildPermData(records, keys) {
    var byField = {};
    records.forEach(function (r) { (byField[r.Field] = byField[r.Field] || []).push(r); });
    return keys.map(function (key) {
        var meta = allFields.find(function (f) { return f._uniqueKey === key; });
        var parts = key.split(".");
        var objName = parts[0], api = parts.slice(1).join(".");
        var perms = (byField[key] || []).map(function (r) {
            var isProfile = !!(r.Parent && r.Parent.IsOwnedByProfile);
            var name = getParentDisplayName(r.ParentId, r.Parent, isProfile);
            return { recordId: r.Id, parentId: r.ParentId, name: name, label: name, isProfile: isProfile, read: r.PermissionsRead, edit: r.PermissionsEdit };
        }).sort(function (a, b) {
            if (a.isProfile !== b.isProfile) return b.isProfile ? 1 : -1;
            return a.label.localeCompare(b.label);
        });
        return { objName: objName, fieldApiName: api, label: meta ? (meta.label || api) : api, perms: perms };
    });
}

function permBlock(titleLeft, titleMain, titleSub) {
    var block = document.createElement("div"); block.className = "field-block";
    var head = document.createElement("div"); head.className = "field-block-header";
    if (titleLeft) { var tag = document.createElement("span"); tag.className = "field-block-obj"; tag.textContent = titleLeft; head.appendChild(tag); }
    var meta = document.createElement("div");
    var l = document.createElement("div"); l.className = "field-block-label"; l.textContent = titleMain;
    var s = document.createElement("div"); s.className = "field-block-api"; s.textContent = titleSub || "";
    meta.appendChild(l); meta.appendChild(s); head.appendChild(meta);
    block.appendChild(head);
    return block;
}
function permTable(headers) {
    var wrap = document.createElement("div"); wrap.className = "perm-table-wrap";
    var table = document.createElement("table"); table.className = "perm-table";
    var thead = document.createElement("thead"), hr = document.createElement("tr");
    headers.forEach(function (h) { var th = document.createElement("th"); th.textContent = h; hr.appendChild(th); });
    thead.appendChild(hr); table.appendChild(thead);
    var tbody = document.createElement("tbody"); table.appendChild(tbody);
    wrap.appendChild(table);
    return { wrap: wrap, tbody: tbody };
}

function renderFieldPermissions(data) {
    var host = $("permList");
    host.innerHTML = "";
    var frag = document.createDocumentFragment();
    data.forEach(function (field) {
        var block = permBlock(field.objName, field.label, field.fieldApiName);
        if (!field.perms.length) {
            var e = document.createElement("div"); e.className = "no-entries";
            e.textContent = "No profile or permission set grants this field.";
            block.appendChild(e);
        } else {
            var t = permTable(["Type", "Profile / permission set", "Read", "Edit", ""]);
            field.perms.forEach(function (p) {
                var tr = document.createElement("tr");
                var tdType = document.createElement("td"); tdType.appendChild(makeTypeTag(p.isProfile));
                var rd = makeToggle(p.read), ed = makeToggle(p.edit, !p.read);
                rd.cb.addEventListener("change", function () {
                    if (!rd.cb.checked) { ed.cb.checked = false; ed.cb.disabled = true; } else ed.cb.disabled = false;
                });
                var tdR = document.createElement("td"); tdR.appendChild(rd.label);
                var tdE = document.createElement("td"); tdE.appendChild(ed.label);
                var tdS = document.createElement("td");
                var btn = makeSaveBtn(function () {
                    saveFieldPerm(p, rd.cb.checked, ed.cb.checked, btn, field.objName + "." + field.fieldApiName);
                });
                tdS.appendChild(btn);
                tr.appendChild(tdType); tr.appendChild(makeNameCell(p.label));
                tr.appendChild(tdR); tr.appendChild(tdE); tr.appendChild(tdS);
                t.tbody.appendChild(tr);
            });
            block.appendChild(t.wrap);
        }
        frag.appendChild(block);
    });
    host.appendChild(frag);
}

async function saveFieldPerm(p, read, edit, btn, fieldKey) {
    btn.disabled = true; btn.textContent = "…";
    try {
        var id = p.recordId;
        if (!id && p.parentId) {
            var found = await pagedQuery("SELECT Id FROM FieldPermissions WHERE Field='" + escSoql(fieldKey) + "' AND ParentId='" + escSoql(p.parentId) + "'");
            if (found.length) id = found[0].Id;
        }
        if (!id) { toast("No FieldPermissions row for " + fieldKey + " / " + p.label, true); btn.textContent = "Save"; btn.disabled = false; return; }
        var res = await callApi(apiPath("/sobjects/FieldPermissions/" + id), null, "PATCH", { PermissionsRead: read, PermissionsEdit: edit });
        if (!res.success) { toast("Save failed: " + res.error, true); btn.textContent = "Save"; btn.disabled = false; return; }
        p.recordId = id; p.read = read; p.edit = edit;
        flashSaved(btn);
        toast("Saved " + fieldKey + " for " + p.label);
    } catch (e) { toast("Save failed: " + e.message, true); btn.textContent = "Save"; btn.disabled = false; }
}

// ── object-level security ────────────────────────────────────────────────────
async function loadObjectPermissions() {
    if (!selectedObjNames.size) { toast("Pick at least one object.", true); return; }
    $("objPermList").innerHTML = loadingHTML("Reading object permissions…");
    $("objPermHint").textContent = "Fetching…";
    $("dlObjCsvBtn").hidden = $("dlObjXlsxBtn").hidden = true;
    var objs = Array.from(selectedObjNames);
    try {
        var all = [];
        for (var i = 0; i < objs.length; i += 200) {
            var inClause = objs.slice(i, i + 200).map(function (n) { return "'" + escSoql(n) + "'"; }).join(",");
            all = all.concat(await pagedQuery(
                "SELECT Id, SobjectType, PermissionsCreate, PermissionsRead, PermissionsEdit, PermissionsDelete, " +
                "PermissionsViewAllRecords, PermissionsModifyAllRecords, ParentId, Parent.Name, Parent.Label, Parent.IsOwnedByProfile " +
                "FROM ObjectPermissions WHERE SobjectType IN (" + inClause + ")"));
        }
        await resolveProfileNames(all.filter(function (r) { return r.Parent && r.Parent.IsOwnedByProfile; }).map(function (r) { return r.ParentId; }));
        lastObjPermData = buildObjPermData(all, objs);
        renderObjectPermissions(lastObjPermData);
        var total = lastObjPermData.reduce(function (s, o) { return s + o.perms.length; }, 0);
        $("objPermHint").textContent = lastObjPermData.length + " object(s), " + total + " grants";
        $("dlObjCsvBtn").hidden = $("dlObjXlsxBtn").hidden = false;
    } catch (err) {
        $("objPermList").innerHTML = emptyHTML("Could not read object permissions: " + err.message);
        $("objPermHint").textContent = "Failed.";
    }
}

function buildObjPermData(records, objNames) {
    var byObj = {};
    records.forEach(function (r) { (byObj[r.SobjectType] = byObj[r.SobjectType] || []).push(r); });
    return objNames.map(function (objName) {
        var meta = allObjects.find(function (o) { return o.name === objName; });
        var perms = (byObj[objName] || []).map(function (r) {
            var isProfile = !!(r.Parent && r.Parent.IsOwnedByProfile);
            var name = getParentDisplayName(r.ParentId, r.Parent, isProfile);
            return {
                recordId: r.Id, parentId: r.ParentId, name: name, label: name, isProfile: isProfile,
                create: r.PermissionsCreate, read: r.PermissionsRead, edit: r.PermissionsEdit,
                del: r.PermissionsDelete, viewAll: r.PermissionsViewAllRecords, modAll: r.PermissionsModifyAllRecords
            };
        }).sort(function (a, b) {
            if (a.isProfile !== b.isProfile) return b.isProfile ? 1 : -1;
            return a.label.localeCompare(b.label);
        });
        return { objName: objName, label: meta ? (meta.label || objName) : objName, perms: perms };
    });
}

function renderObjectPermissions(data) {
    var host = $("objPermList");
    host.innerHTML = "";
    var frag = document.createDocumentFragment();
    data.forEach(function (obj) {
        var block = permBlock(null, obj.label, obj.objName);
        if (!obj.perms.length) {
            var e = document.createElement("div"); e.className = "no-entries"; e.textContent = "No grants found."; block.appendChild(e);
        } else {
            var t = permTable(["Type", "Profile / permission set", "Create", "Read", "Edit", "Delete", "View all", "Modify all", ""]);
            obj.perms.forEach(function (p) {
                var tr = document.createElement("tr");
                var tdType = document.createElement("td"); tdType.appendChild(makeTypeTag(p.isProfile));
                tr.appendChild(tdType); tr.appendChild(makeNameCell(p.label));
                var cbs = {};
                ["create", "read", "edit", "del", "viewAll", "modAll"].forEach(function (k) {
                    var tg = makeToggle(p[k]); cbs[k] = tg.cb;
                    var td = document.createElement("td"); td.appendChild(tg.label); tr.appendChild(td);
                });
                var tdS = document.createElement("td");
                var btn = makeSaveBtn(function () { saveObjPerm(p, obj.objName, cbs, btn); });
                tdS.appendChild(btn); tr.appendChild(tdS);
                t.tbody.appendChild(tr);
            });
            block.appendChild(t.wrap);
        }
        frag.appendChild(block);
    });
    host.appendChild(frag);
}

async function saveObjPerm(p, objName, cbs, btn) {
    btn.disabled = true; btn.textContent = "…";
    try {
        var id = p.recordId;
        if (!id && p.parentId) {
            var found = await pagedQuery("SELECT Id FROM ObjectPermissions WHERE SobjectType='" + escSoql(objName) + "' AND ParentId='" + escSoql(p.parentId) + "'");
            if (found.length) id = found[0].Id;
        }
        if (!id) { toast("No ObjectPermissions row for " + objName, true); btn.textContent = "Save"; btn.disabled = false; return; }
        var body = {
            PermissionsCreate: cbs.create.checked, PermissionsRead: cbs.read.checked,
            PermissionsEdit: cbs.edit.checked, PermissionsDelete: cbs.del.checked,
            PermissionsViewAllRecords: cbs.viewAll.checked, PermissionsModifyAllRecords: cbs.modAll.checked
        };
        var res = await callApi(apiPath("/sobjects/ObjectPermissions/" + id), null, "PATCH", body);
        if (!res.success) { toast("Save failed: " + res.error, true); btn.textContent = "Save"; btn.disabled = false; return; }
        p.recordId = id;
        flashSaved(btn);
        toast("Saved " + objName + " for " + p.label);
    } catch (e) { toast("Save failed: " + e.message, true); btn.textContent = "Save"; btn.disabled = false; }
}

// ── component permissions ────────────────────────────────────────────────────
async function loadComponentPermissions() {
    var cfg = COMP_CONFIG[currentCompType];
    if (!cfg) return;
    if (cfg.mode === "sysperm") return loadSystemPermissions();
    if (!selectedCompItems.size) { toast("Pick at least one item.", true); return; }

    $("compPermList").innerHTML = loadingHTML("Reading permissions…");
    $("compPermHint").textContent = "Fetching…";
    $("dlCompCsvBtn").hidden = $("dlCompXlsxBtn").hidden = true;

    var ids = Array.from(selectedCompItems);
    var map = {}; allCompItems.forEach(function (i) { map[i.id] = i; });
    try {
        if (cfg.mode === "setupentity") await loadSetupEntityPermissions(ids, map);
        else if (cfg.mode === "flow") await loadFlowPermissions(ids, map);
        else if (cfg.mode === "tab") await loadTabPermissions(ids, map);
        else if (cfg.mode === "recordtype") await loadRecordTypePermissions(ids, map);
        var total = lastCompPermData.reduce(function (s, d) { return s + d.perms.length; }, 0);
        $("compPermHint").textContent = lastCompPermData.length + " item(s), " + total + " rows";
        $("dlCompCsvBtn").hidden = $("dlCompXlsxBtn").hidden = false;
    } catch (err) {
        $("compPermList").innerHTML = emptyHTML("Could not read permissions: " + err.message);
        $("compPermHint").textContent = "Failed.";
    }
}

async function loadAllProfilesAndPermsets() {
    var out = [];
    try {
        var profiles = await pagedQuery("SELECT Id, Name FROM Profile ORDER BY Name");
        profiles.forEach(function (r) { profileNameCache[r.Id] = r.Name; });
    } catch (e) {}
    try {
        var sets = await pagedQuery("SELECT Id, Name, Label, IsOwnedByProfile, ProfileId FROM PermissionSet ORDER BY IsOwnedByProfile DESC, Label");
        var profileIds = sets.filter(function (s) { return s.IsOwnedByProfile && s.ProfileId; }).map(function (s) { return s.ProfileId; });
        await resolveProfileNames(profileIds);
        out = sets.map(function (s) {
            return {
                id: s.Id,
                name: s.IsOwnedByProfile ? (profileNameCache[s.ProfileId] || s.Label || s.Name) : (s.Label || s.Name),
                isProfile: !!s.IsOwnedByProfile
            };
        });
    } catch (e) {}
    return out;
}

async function loadSetupEntityPermissions(ids, map) {
    var parents = await loadAllProfilesAndPermsets();
    var all = [];
    for (var i = 0; i < ids.length; i += 200) {
        var inClause = ids.slice(i, i + 200).map(function (id) { return "'" + escSoql(id) + "'"; }).join(",");
        all = all.concat(await pagedQuery("SELECT Id, SetupEntityId, ParentId FROM SetupEntityAccess WHERE SetupEntityId IN (" + inClause + ")"));
    }
    var existing = {};
    all.forEach(function (r) {
        existing[r.SetupEntityId] = existing[r.SetupEntityId] || {};
        existing[r.SetupEntityId][r.ParentId] = r.Id;
    });
    lastCompPermData = ids.map(function (id) {
        var item = map[id] || { id: id, label: id, name: id };
        var have = existing[id] || {};
        var perms = parents.map(function (p) {
            return { recordId: have[p.id] || null, parentId: p.id, name: p.name, label: p.name, isProfile: p.isProfile, enabled: !!have[p.id] };
        });
        return { itemId: id, label: item.label, name: item.name, perms: perms };
    });
    renderSetupEntityPermissions(lastCompPermData);
}

function renderSetupEntityPermissions(data) {
    var host = $("compPermList");
    host.innerHTML = "";
    var frag = document.createDocumentFragment();
    data.forEach(function (item) {
        var block = permBlock(null, item.label, item.name);
        var t = permTable(["Type", "Profile / permission set", "Access", ""]);
        var granted = item.perms.filter(function (p) { return p.enabled; });
        var rest = item.perms.filter(function (p) { return !p.enabled; });
        granted.concat(rest).forEach(function (p) {
            var tr = document.createElement("tr");
            var tdType = document.createElement("td"); tdType.appendChild(makeTypeTag(p.isProfile));
            var tg = makeToggle(p.enabled);
            var tdA = document.createElement("td"); tdA.appendChild(tg.label);
            var tdS = document.createElement("td");
            var btn = makeSaveBtn(function () { saveSetupEntityPerm(p, tg.cb.checked, btn, item.itemId, item.label); });
            tdS.appendChild(btn);
            tr.appendChild(tdType); tr.appendChild(makeNameCell(p.label)); tr.appendChild(tdA); tr.appendChild(tdS);
            t.tbody.appendChild(tr);
        });
        block.appendChild(t.wrap);
        frag.appendChild(block);
    });
    host.appendChild(frag);
}

async function saveSetupEntityPerm(p, enabled, btn, entityId, entityLabel) {
    btn.disabled = true; btn.textContent = "…";
    try {
        if (enabled) {
            if (p.recordId) { flashSaved(btn); toast("Already granted to " + p.label); return; }
            var res = await callApi(apiPath("/sobjects/SetupEntityAccess"), null, "POST", { SetupEntityId: entityId, ParentId: p.parentId });
            if (res.success && res.data && res.data.id) {
                p.recordId = res.data.id; p.enabled = true;
                flashSaved(btn); toast("Granted " + entityLabel + " to " + p.label);
                return;
            }
            var msg = res.error || "Insert failed";
            if (/DUPLICATE_VALUE|already exists/i.test(msg)) {
                var found = await pagedQuery("SELECT Id FROM SetupEntityAccess WHERE SetupEntityId='" + escSoql(entityId) + "' AND ParentId='" + escSoql(p.parentId) + "'");
                if (found.length) { p.recordId = found[0].Id; p.enabled = true; flashSaved(btn); return; }
            }
            toast("Could not grant access: " + msg, true);
            btn.textContent = "Save"; btn.disabled = false;
        } else {
            if (!p.recordId) {
                var f2 = await pagedQuery("SELECT Id FROM SetupEntityAccess WHERE SetupEntityId='" + escSoql(entityId) + "' AND ParentId='" + escSoql(p.parentId) + "'");
                if (f2.length) p.recordId = f2[0].Id;
            }
            if (!p.recordId) { p.enabled = false; flashSaved(btn); return; }
            var del = await callApi(apiPath("/sobjects/SetupEntityAccess/" + p.recordId), null, "DELETE");
            if (!del.success) { toast("Could not revoke: " + del.error, true); btn.textContent = "Save"; btn.disabled = false; return; }
            p.recordId = null; p.enabled = false;
            flashSaved(btn); toast("Revoked " + entityLabel + " from " + p.label);
        }
    } catch (e) { toast("Save failed: " + e.message, true); btn.textContent = "Save"; btn.disabled = false; }
}

async function loadFlowPermissions(ids, map) {
    var entityToItem = {}, lookup = [];
    ids.forEach(function (id) {
        var item = map[id];
        if (item && item.activeVersionId) entityToItem[item.activeVersionId] = id;
        else if (item) lookup.push(item);
    });
    for (var li = 0; li < lookup.length; li += 100) {
        var chunk = lookup.slice(li, li + 100);
        var inClause = chunk.map(function (i) { return "'" + escSoql(i.name) + "'"; }).join(",");
        try {
            var flows = await pagedQuery("SELECT Id, ApiName FROM Flow WHERE ApiName IN (" + inClause + ") AND Status = 'Active' ORDER BY LastModifiedDate DESC");
            var seen = {};
            flows.forEach(function (fr) {
                if (seen[fr.ApiName]) return;
                seen[fr.ApiName] = true;
                var m = chunk.find(function (i) { return i.name === fr.ApiName; });
                if (m) entityToItem[fr.Id] = m.id;
            });
        } catch (e) {}
    }
    var realIds = Object.keys(entityToItem), all = [];
    for (var i = 0; i < realIds.length; i += 200) {
        var ic = realIds.slice(i, i + 200).map(function (id) { return "'" + escSoql(id) + "'"; }).join(",");
        try {
            all = all.concat(await pagedQuery("SELECT Id, SetupEntityId, ParentId, Parent.Name, Parent.Label, Parent.IsOwnedByProfile FROM SetupEntityAccess WHERE SetupEntityId IN (" + ic + ")"));
        } catch (e) {}
    }
    await resolveProfileNames(all.filter(function (r) { return r.Parent && r.Parent.IsOwnedByProfile; }).map(function (r) { return r.ParentId; }));
    var byItem = {};
    all.forEach(function (r) {
        var id = entityToItem[r.SetupEntityId];
        if (id) (byItem[id] = byItem[id] || []).push(r);
    });
    lastCompPermData = ids.map(function (id) {
        var item = map[id] || { id: id, label: id, name: id };
        var perms = (byItem[id] || []).map(function (r) {
            var isProfile = !!(r.Parent && r.Parent.IsOwnedByProfile);
            var name = getParentDisplayName(r.ParentId, r.Parent, isProfile);
            return { recordId: r.Id, parentId: r.ParentId, name: name, label: name, isProfile: isProfile, enabled: true };
        }).sort(function (a, b) { return a.isProfile !== b.isProfile ? (b.isProfile ? 1 : -1) : a.label.localeCompare(b.label); });
        return { itemId: id, label: item.label, name: item.name, perms: perms };
    });
    renderReadOnlyAccess(lastCompPermData, "No profile or permission set can run this flow.");
}

function renderReadOnlyAccess(data, emptyMsg) {
    var host = $("compPermList");
    host.innerHTML = "";
    var frag = document.createDocumentFragment();
    data.forEach(function (item) {
        var block = permBlock(null, item.label, item.name);
        if (!item.perms.length) {
            var e = document.createElement("div"); e.className = "no-entries"; e.textContent = emptyMsg; block.appendChild(e);
        } else {
            var t = permTable(["Type", "Profile / permission set", "Access"]);
            item.perms.forEach(function (p) {
                var tr = document.createElement("tr");
                var tdType = document.createElement("td"); tdType.appendChild(makeTypeTag(p.isProfile));
                var tdA = document.createElement("td");
                var badge = document.createElement("span"); badge.className = "badge badge-yes"; badge.textContent = "Enabled";
                tdA.appendChild(badge);
                tr.appendChild(tdType); tr.appendChild(makeNameCell(p.label)); tr.appendChild(tdA);
                t.tbody.appendChild(tr);
            });
            block.appendChild(t.wrap);
        }
        frag.appendChild(block);
    });
    host.appendChild(frag);
}

async function loadTabPermissions(ids, map) {
    var names = ids.map(function (id) { return map[id] ? map[id].name : null; }).filter(Boolean);
    var all = [];
    for (var i = 0; i < names.length; i += 200) {
        var inClause = names.slice(i, i + 200).map(function (n) { return "'" + escSoql(n) + "'"; }).join(",");
        all = all.concat(await pagedQuery("SELECT Id, Name, Visibility, ParentId, Parent.Name, Parent.Label, Parent.IsOwnedByProfile FROM PermissionSetTabSetting WHERE Name IN (" + inClause + ")"));
    }
    await resolveProfileNames(all.filter(function (r) { return r.Parent && r.Parent.IsOwnedByProfile; }).map(function (r) { return r.ParentId; }));
    var byName = {};
    all.forEach(function (r) { (byName[r.Name] = byName[r.Name] || []).push(r); });
    lastCompPermData = ids.map(function (id) {
        var item = map[id] || { id: id, label: id, name: id };
        var perms = (byName[item.name] || []).map(function (r) {
            var isProfile = !!(r.Parent && r.Parent.IsOwnedByProfile);
            var name = getParentDisplayName(r.ParentId, r.Parent, isProfile);
            return { recordId: r.Id, parentId: r.ParentId, name: name, label: name, isProfile: isProfile, visibility: r.Visibility || "Hidden" };
        }).sort(function (a, b) { return a.isProfile !== b.isProfile ? (b.isProfile ? 1 : -1) : a.label.localeCompare(b.label); });
        return { itemId: id, label: item.label, name: item.name, perms: perms };
    });
    renderTabPermissions(lastCompPermData);
}

function renderTabPermissions(data) {
    var host = $("compPermList");
    host.innerHTML = "";
    var frag = document.createDocumentFragment();
    data.forEach(function (item) {
        var block = permBlock(null, item.label, item.name);
        if (!item.perms.length) {
            var e = document.createElement("div"); e.className = "no-entries"; e.textContent = "No tab settings found."; block.appendChild(e);
        } else {
            var t = permTable(["Type", "Profile / permission set", "Visibility", ""]);
            item.perms.forEach(function (p) {
                var tr = document.createElement("tr");
                var tdType = document.createElement("td"); tdType.appendChild(makeTypeTag(p.isProfile));
                var sel = document.createElement("select"); sel.className = "input auto";
                ["DefaultOn", "DefaultOff", "Hidden"].forEach(function (v) {
                    var o = document.createElement("option"); o.value = v; o.textContent = v;
                    if (p.visibility === v) o.selected = true;
                    sel.appendChild(o);
                });
                var tdV = document.createElement("td"); tdV.appendChild(sel);
                var tdS = document.createElement("td");
                var btn = makeSaveBtn(function () { saveTabPerm(p, sel.value, btn, item.name); });
                tdS.appendChild(btn);
                tr.appendChild(tdType); tr.appendChild(makeNameCell(p.label)); tr.appendChild(tdV); tr.appendChild(tdS);
                t.tbody.appendChild(tr);
            });
            block.appendChild(t.wrap);
        }
        frag.appendChild(block);
    });
    host.appendChild(frag);
}

async function saveTabPerm(p, visibility, btn, tabName) {
    btn.disabled = true; btn.textContent = "…";
    try {
        var id = p.recordId;
        if (!id && p.parentId) {
            var found = await pagedQuery("SELECT Id FROM PermissionSetTabSetting WHERE Name='" + escSoql(tabName) + "' AND ParentId='" + escSoql(p.parentId) + "'");
            if (found.length) id = found[0].Id;
        }
        if (!id) { toast("No tab setting row for " + tabName, true); btn.textContent = "Save"; btn.disabled = false; return; }
        var res = await callApi(apiPath("/sobjects/PermissionSetTabSetting/" + id), null, "PATCH", { Visibility: visibility });
        if (!res.success) { toast("Save failed: " + res.error, true); btn.textContent = "Save"; btn.disabled = false; return; }
        p.recordId = id; p.visibility = visibility;
        flashSaved(btn); toast("Tab visibility saved for " + p.label);
    } catch (e) { toast("Save failed: " + e.message, true); btn.textContent = "Save"; btn.disabled = false; }
}

async function loadRecordTypePermissions(ids, map) {
    var profileRows = [], permsetRows = [];
    for (var i = 0; i < ids.length; i += 200) {
        var inClause = ids.slice(i, i + 200).map(function (id) { return "'" + escSoql(id) + "'"; }).join(",");
        try { profileRows = profileRows.concat(await pagedQuery("SELECT Id, RecordTypeId, IsVisible, IsDefault, ProfileId, Profile.Name FROM ProfileRecordTypeVisibility WHERE RecordTypeId IN (" + inClause + ")")); } catch (e) {}
        try { permsetRows = permsetRows.concat(await pagedQuery("SELECT Id, SetupEntityId, ParentId, Parent.Name, Parent.Label, Parent.IsOwnedByProfile FROM SetupEntityAccess WHERE SetupEntityId IN (" + inClause + ") AND Parent.IsOwnedByProfile = false")); } catch (e) {}
    }
    profileRows.forEach(function (r) { if (r.ProfileId && r.Profile) profileNameCache[r.ProfileId] = r.Profile.Name; });
    var byRtProfile = {}, byRtSet = {};
    profileRows.forEach(function (r) { (byRtProfile[r.RecordTypeId] = byRtProfile[r.RecordTypeId] || []).push(r); });
    permsetRows.forEach(function (r) { (byRtSet[r.SetupEntityId] = byRtSet[r.SetupEntityId] || []).push(r); });

    lastCompPermData = ids.map(function (id) {
        var item = map[id] || { id: id, label: id, name: id };
        var perms = [];
        (byRtProfile[id] || []).forEach(function (r) {
            var n = profileNameCache[r.ProfileId] || (r.Profile && r.Profile.Name) || r.ProfileId;
            perms.push({ recordId: r.Id, parentId: r.ProfileId, name: n, label: n, isProfile: true, visible: r.IsVisible, isDefault: r.IsDefault });
        });
        (byRtSet[id] || []).forEach(function (r) {
            var n = getParentDisplayName(r.ParentId, r.Parent, false);
            perms.push({ recordId: r.Id, parentId: r.ParentId, name: n, label: n, isProfile: false, visible: true, isDefault: false });
        });
        perms.sort(function (a, b) { return a.isProfile !== b.isProfile ? (b.isProfile ? 1 : -1) : a.label.localeCompare(b.label); });
        return { itemId: id, label: item.label + (item.obj ? " (" + item.obj + ")" : ""), name: item.name, perms: perms };
    });
    renderRecordTypePermissions(lastCompPermData);
}

function renderRecordTypePermissions(data) {
    var host = $("compPermList");
    host.innerHTML = "";
    var frag = document.createDocumentFragment();
    data.forEach(function (item) {
        var block = permBlock(null, item.label, item.name);
        if (!item.perms.length) {
            var e = document.createElement("div"); e.className = "no-entries"; e.textContent = "No record type visibility rows found."; block.appendChild(e);
        } else {
            var t = permTable(["Type", "Profile / permission set", "Visible", "Default", ""]);
            item.perms.forEach(function (p) {
                var tr = document.createElement("tr");
                var tdType = document.createElement("td"); tdType.appendChild(makeTypeTag(p.isProfile));
                var vis = makeToggle(p.visible);
                var tdV = document.createElement("td"); tdV.appendChild(vis.label);
                var tdD = document.createElement("td"), def = null;
                if (p.isProfile) { def = makeToggle(p.isDefault); tdD.appendChild(def.label); }
                else tdD.textContent = "—";
                var tdS = document.createElement("td");
                if (p.isProfile) {
                    var btn = makeSaveBtn(function () { saveRecordTypePerm(p, vis.cb.checked, def ? def.cb.checked : false, btn, item.itemId); });
                    tdS.appendChild(btn);
                } else tdS.textContent = "—";
                tr.appendChild(tdType); tr.appendChild(makeNameCell(p.label)); tr.appendChild(tdV); tr.appendChild(tdD); tr.appendChild(tdS);
                t.tbody.appendChild(tr);
            });
            block.appendChild(t.wrap);
        }
        frag.appendChild(block);
    });
    host.appendChild(frag);
}

async function saveRecordTypePerm(p, visible, isDefault, btn, rtId) {
    btn.disabled = true; btn.textContent = "…";
    try {
        var id = p.recordId;
        if (!id && p.parentId) {
            var found = await pagedQuery("SELECT Id FROM ProfileRecordTypeVisibility WHERE RecordTypeId='" + escSoql(rtId) + "' AND ProfileId='" + escSoql(p.parentId) + "'");
            if (found.length) id = found[0].Id;
        }
        if (!id) { toast("No visibility row found.", true); btn.textContent = "Save"; btn.disabled = false; return; }
        var res = await callApi(apiPath("/sobjects/ProfileRecordTypeVisibility/" + id), null, "PATCH", { IsVisible: visible, IsDefault: isDefault });
        if (!res.success) { toast("Save failed: " + res.error, true); btn.textContent = "Save"; btn.disabled = false; return; }
        p.recordId = id; p.visible = visible; p.isDefault = isDefault;
        flashSaved(btn); toast("Record type visibility saved for " + p.label);
    } catch (e) { toast("Save failed: " + e.message, true); btn.textContent = "Save"; btn.disabled = false; }
}

// ── system permissions ───────────────────────────────────────────────────────
async function loadSystemPermissions() {
    $("compPermList").innerHTML = loadingHTML("Reading system permissions…");
    $("compPermHint").textContent = "Fetching…";
    $("dlCompCsvBtn").hidden = $("dlCompXlsxBtn").hidden = true;
    try {
        var fields = await discoverValidSysPermFields();
        var list = fields.map(function (f) { return f.api; }).join(", ");
        var records = await pagedQuery("SELECT Id, Name, Label, IsOwnedByProfile, ProfileId, " + list + " FROM PermissionSet ORDER BY IsOwnedByProfile DESC, Label");
        await resolveProfileNames(records.filter(function (r) { return r.IsOwnedByProfile && r.ProfileId; }).map(function (r) { return r.ProfileId; }));
        records.forEach(function (r) {
            r._displayName = (r.IsOwnedByProfile && profileNameCache[r.ProfileId]) ? profileNameCache[r.ProfileId] : (r.Label || r.Name);
        });
        lastCompPermData = [{ itemId: "__sysperm__", label: "System permissions", name: "System permissions", perms: [], rawRecords: records }];
        renderSystemPermissions(records, fields);
        $("compPermHint").textContent = records.length + " profiles and permission sets";
        $("dlCompCsvBtn").hidden = $("dlCompXlsxBtn").hidden = false;
    } catch (err) {
        $("compPermList").innerHTML = emptyHTML("Could not read system permissions: " + err.message);
        $("compPermHint").textContent = "Failed.";
    }
}

function renderSystemPermissions(records, fields) {
    var host = $("compPermList");
    host.innerHTML = "";
    var t = permTable(["Type", "Name"].concat(fields.map(function (f) { return f.label; })).concat([""]));
    records.forEach(function (r) {
        var tr = document.createElement("tr");
        var tdType = document.createElement("td"); tdType.appendChild(makeTypeTag(r.IsOwnedByProfile));
        tr.appendChild(tdType); tr.appendChild(makeNameCell(r._displayName));
        var cbs = {};
        fields.forEach(function (f) {
            var tg = makeToggle(r[f.api]); cbs[f.api] = tg.cb;
            var td = document.createElement("td"); td.appendChild(tg.label); tr.appendChild(td);
        });
        var tdS = document.createElement("td");
        var btn = makeSaveBtn(function () { saveSysPerm(r, cbs, btn, fields); });
        tdS.appendChild(btn); tr.appendChild(tdS);
        t.tbody.appendChild(tr);
    });
    host.appendChild(t.wrap);
}

async function saveSysPerm(rec, cbs, btn, fields) {
    btn.disabled = true; btn.textContent = "…";
    try {
        var body = {};
        fields.forEach(function (f) { body[f.api] = cbs[f.api].checked; });
        var res = await callApi(apiPath("/sobjects/PermissionSet/" + rec.Id), null, "PATCH", body);
        if (!res.success) { toast("Save failed: " + res.error, true); btn.textContent = "Save"; btn.disabled = false; return; }
        flashSaved(btn);
        toast("System permissions saved for " + rec._displayName);
    } catch (e) { toast("Save failed: " + e.message, true); btn.textContent = "Save"; btn.disabled = false; }
}

// ── exports ──────────────────────────────────────────────────────────────────
function buildFlatRows() {
    var rows = [];
    lastPermData.forEach(function (f) {
        if (!f.perms.length) {
            rows.push({ Object: f.objName, "Field label": f.label, "Field api": f.fieldApiName, Type: "", "Profile / permission set": "(none)", Read: "", Edit: "" });
        } else {
            f.perms.forEach(function (p) {
                rows.push({
                    Object: f.objName, "Field label": f.label, "Field api": f.fieldApiName,
                    Type: p.isProfile ? "Profile" : "Permission set", "Profile / permission set": p.label,
                    Read: p.read ? "Yes" : "No", Edit: p.edit ? "Yes" : "No"
                });
            });
        }
    });
    return rows;
}
function buildObjFlatRows() {
    var rows = [];
    lastObjPermData.forEach(function (o) {
        if (!o.perms.length) {
            rows.push({ Object: o.objName, Label: o.label, Type: "", "Profile / permission set": "(none)", Create: "", Read: "", Edit: "", Delete: "", "View all": "", "Modify all": "" });
        } else {
            o.perms.forEach(function (p) {
                rows.push({
                    Object: o.objName, Label: o.label, Type: p.isProfile ? "Profile" : "Permission set",
                    "Profile / permission set": p.label,
                    Create: p.create ? "Yes" : "No", Read: p.read ? "Yes" : "No", Edit: p.edit ? "Yes" : "No",
                    Delete: p.del ? "Yes" : "No", "View all": p.viewAll ? "Yes" : "No", "Modify all": p.modAll ? "Yes" : "No"
                });
            });
        }
    });
    return rows;
}
function buildCompFlatRows() {
    var rows = [];
    if (currentCompType === "sysperm" && lastCompPermData.length && lastCompPermData[0].rawRecords) {
        var flds = validSysPermFields || SYS_PERM_FIELDS;
        lastCompPermData[0].rawRecords.forEach(function (r) {
            var row = { Type: r.IsOwnedByProfile ? "Profile" : "Permission set", Name: r._displayName };
            flds.forEach(function (f) { row[f.label] = r[f.api] ? "Yes" : "No"; });
            rows.push(row);
        });
        return rows;
    }
    lastCompPermData.forEach(function (item) {
        if (!item.perms.length) {
            rows.push({ Component: item.label, "Api name": item.name, Type: "", "Profile / permission set": "(none)", Permission: "" });
        } else {
            item.perms.forEach(function (p) {
                var row = { Component: item.label, "Api name": item.name, Type: p.isProfile ? "Profile" : "Permission set", "Profile / permission set": p.label };
                if (currentCompType === "tab") row.Visibility = p.visibility || "";
                else if (currentCompType === "recordtype") { row.Visible = p.visible ? "Yes" : "No"; row.Default = p.isDefault ? "Yes" : "No"; }
                else row.Enabled = p.enabled ? "Yes" : "No";
                rows.push(row);
            });
        }
    });
    return rows;
}

function downloadAllFieldsCSV() {
    if (!allFields.length) { toast("Load some fields first.", true); return; }
    downloadCSVFromRows(allFields.map(function (f) {
        return {
            Object: f._objectName, "Field label": f.label || f.name, "Field api": f.name, Type: f.type || "",
            Length: f.length || "", Required: f.nillable === false ? "Yes" : "No", Unique: f.unique ? "Yes" : "No",
            Createable: f.createable ? "Yes" : "No", Updateable: f.updateable ? "Yes" : "No",
            "External id": f.externalId ? "Yes" : "No", "Picklist values": (f.picklistValues || []).map(function (p) { return p.value; }).join(" | "),
            "References": (f.referenceTo || []).join(" | "), Formula: f.calculated ? "Yes" : "No"
        };
    }), "fields_" + Array.from(selectedObjNames).join("_").slice(0, 60) + ".csv");
}

function copyFieldSoql() {
    if (!allFields.length) { toast("Load some fields first.", true); return; }
    var byObj = {};
    (selectedFields.size ? allFields.filter(function (f) { return selectedFields.has(f._uniqueKey); }) : allFields)
        .forEach(function (f) { (byObj[f._objectName] = byObj[f._objectName] || []).push(f.name); });
    var out = Object.keys(byObj).map(function (o) {
        return "SELECT " + byObj[o].join(", ") + "\nFROM " + o + "\nLIMIT 200";
    }).join("\n\n");
    copyText(out, "SOQL copied");
}

// ── view wiring ──────────────────────────────────────────────────────────────
function switchObjTab(tab) {
    activeObjTab = tab;
    $("tabFields").classList.toggle("active", tab === "fields");
    $("tabObjPerms").classList.toggle("active", tab === "objperms");
    $("panelFields").hidden = tab !== "fields";
    $("panelObjPerms").hidden = tab !== "objperms";
    $("panelComponent").hidden = true;
}
$("tabFields").addEventListener("click", function () { switchObjTab("fields"); });
$("tabObjPerms").addEventListener("click", function () { switchObjTab("objperms"); });

$("compTypeSelect").addEventListener("change", function () {
    currentCompType = $("compTypeSelect").value;
    $("leftSearch").value = "";
    selectedObjNames.clear(); selectedCompItems.clear(); selectedFields.clear();
    $("compPermList").innerHTML = emptyHTML("Pick items on the left, then load.");
    $("compPermHint").textContent = "Pick items on the left, then load.";
    $("dlCompCsvBtn").hidden = $("dlCompXlsxBtn").hidden = true;

    if (currentCompType === "objects") {
        $("objTabBar").hidden = false;
        $("customOnlyChk").parentElement.hidden = false;
        switchObjTab(activeObjTab);
        setLeftLabel("Objects", allObjects.length);
        allObjects.length ? applyLeftFilter() : loadObjects();
    } else {
        $("objTabBar").hidden = true;
        $("customOnlyChk").parentElement.hidden = true;
        $("panelFields").hidden = true;
        $("panelObjPerms").hidden = true;
        $("panelComponent").hidden = false;
        $("compPermLabel").textContent = COMP_CONFIG[currentCompType].label + " permissions";
        loadComponentItems(currentCompType);
    }
});

var leftTimer, fieldTimer;
$("leftSearch").addEventListener("input", function () { clearTimeout(leftTimer); leftTimer = setTimeout(applyLeftFilter, 120); });
$("fieldSearch").addEventListener("input", function () { clearTimeout(fieldTimer); fieldTimer = setTimeout(filterFields, 120); });
$("customOnlyChk").addEventListener("change", applyLeftFilter);

$("selAllLeftBtn").addEventListener("click", async function () {
    if (currentCompType === "objects") {
        filteredObjects.slice(0, 25).forEach(function (o) { selectedObjNames.add(o.name); });
        if (filteredObjects.length > 25) toast("Selected the first 25 objects — describing more than that at once is slow.");
        renderLeftObjects(filteredObjects);
        await reloadAllFields();
    } else {
        filteredCompItems.forEach(function (i) { selectedCompItems.add(i.id); });
        renderLeftCompItems(filteredCompItems);
    }
});
$("deselAllLeftBtn").addEventListener("click", function () {
    if (currentCompType === "objects") {
        selectedObjNames.clear(); selectedFields.clear();
        renderLeftObjects(filteredObjects);
        allFields = []; filteredFields = [];
        $("fieldList").innerHTML = emptyHTML("Tick an object to load its fields.");
        updateFieldCount();
    } else {
        selectedCompItems.clear();
        renderLeftCompItems(filteredCompItems);
    }
});
$("selAllFieldBtn").addEventListener("click", function () {
    filteredFields.forEach(function (f) { selectedFields.add(f._uniqueKey); });
    renderFields(filteredFields); updateFieldCount();
});
$("deselAllFieldBtn").addEventListener("click", function () {
    filteredFields.forEach(function (f) { selectedFields.delete(f._uniqueKey); });
    renderFields(filteredFields); updateFieldCount();
});

$("viewPermsBtn").addEventListener("click", loadFieldPermissions);
$("viewObjPermsBtn").addEventListener("click", loadObjectPermissions);
$("viewCompPermsBtn").addEventListener("click", loadComponentPermissions);
$("dlAllFieldsBtn").addEventListener("click", downloadAllFieldsCSV);
$("copySoqlBtn").addEventListener("click", copyFieldSoql);
$("downloadCsvBtn").addEventListener("click", function () { downloadCSVFromRows(buildFlatRows(), "field_permissions.csv"); });
$("downloadXlsxBtn").addEventListener("click", function () { exportXLS(buildFlatRows(), "field_permissions.xls", "Field permissions"); });
$("copyTableBtn").addEventListener("click", function () { copyText(rowsToTSV(buildFlatRows()), "Table copied"); });
$("dlObjCsvBtn").addEventListener("click", function () { downloadCSVFromRows(buildObjFlatRows(), "object_permissions.csv"); });
$("dlObjXlsxBtn").addEventListener("click", function () { exportXLS(buildObjFlatRows(), "object_permissions.xls", "Object permissions"); });
$("dlCompCsvBtn").addEventListener("click", function () { downloadCSVFromRows(buildCompFlatRows(), currentCompType + "_permissions.csv"); });
$("dlCompXlsxBtn").addEventListener("click", function () { exportXLS(buildCompFlatRows(), currentCompType + "_permissions.xls", "Permissions"); });

SFPE.onReady(function () {
    if (currentCompType === "objects") loadObjects();
});
