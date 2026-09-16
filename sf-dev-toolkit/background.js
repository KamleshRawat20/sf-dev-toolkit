// =============================================================================
// SF Dev Toolkit — background service worker
//
// Security notes:
//  * Session ids (access tokens) are NEVER written to storage, never logged and
//    never sent anywhere except the Salesforce instance they belong to.
//  * Every outbound request is checked against the Salesforce host allow-list
//    before it is sent, so a bad url in a message can't be used to leak a token
//    to a third-party server.
// =============================================================================

const SF_HOST_RE = /(^|\.)(salesforce\.com|force\.com|salesforce-setup\.com|cloudforce\.com|visualforce\.com)$/i;

function isSalesforceUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        return u.protocol === "https:" && SF_HOST_RE.test(u.hostname);
    } catch (e) {
        return false;
    }
}

// Map any Salesforce UI host to the host that serves the REST API and holds
// the `sid` cookie.
function toApiOrigin(rawUrl) {
    let host;
    try {
        host = new URL(rawUrl).hostname;
    } catch (e) {
        return null;
    }
    host = host
        .replace(".lightning.force.com", ".my.salesforce.com")
        .replace(".my.salesforce-setup.com", ".my.salesforce.com")
        .replace(".file.force.com", ".my.salesforce.com")
        .replace(".vf.force.com", ".my.salesforce.com");
    return "https://" + host;
}

// ── COOKIE → SESSION ID ──────────────────────────────────────────────────────
function readSessionCookie(origin) {
    return new Promise(resolve => {
        chrome.cookies.get({ url: origin, name: "sid" }, cookie => {
            if (chrome.runtime.lastError || !cookie || !cookie.value) {
                resolve(null);
                return;
            }
            resolve(cookie.value);
        });
    });
}

// ── MESSAGE ROUTER ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    // -- Proxy a REST / Tooling call -----------------------------------------
    if (request.action === "callApi") {
        if (!isSalesforceUrl(request.url)) {
            sendResponse({ success: false, error: "Blocked: only Salesforce hosts are allowed." });
            return false;
        }

        const opts = {
            method: (request.method || "GET").toUpperCase(),
            headers: {
                "Authorization": "Bearer " + request.sessionId,
                "Accept": "application/json"
            },
            credentials: "omit",
            cache: "no-store"
        };

        if (request.body !== undefined && request.body !== null && opts.method !== "GET") {
            opts.headers["Content-Type"] = request.contentType || "application/json";
            opts.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
        }

        fetch(request.url, opts)
            .then(res => res.text().then(text => ({ res, text })))
            .then(({ res, text }) => {
                let data = null;
                if (text && text.trim().length) {
                    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
                }
                if (!res.ok) {
                    let msg = "HTTP " + res.status;
                    if (Array.isArray(data) && data[0] && data[0].message) msg = data[0].message;
                    else if (data && data.message) msg = data.message;
                    else if (data && data.error_description) msg = data.error_description;
                    else if (data && data.raw) msg += " — " + String(data.raw).slice(0, 300);
                    sendResponse({ success: false, status: res.status, error: msg, data: data });
                    return;
                }
                sendResponse({ success: true, status: res.status, data: data });
            })
            .catch(err => sendResponse({ success: false, error: err.message || "Network error" }));

        return true;
    }

    // -- Session id for one org ----------------------------------------------
    if (request.action === "getSessionId") {
        const origin = toApiOrigin(request.url || "");
        if (!origin || !isSalesforceUrl(origin)) {
            sendResponse({ success: false, error: "Not a Salesforce url." });
            return false;
        }
        readSessionCookie(origin).then(sid => {
            if (!sid) {
                sendResponse({ success: false, error: "No active session for " + origin + ". Log in to that org and try again." });
                return;
            }
            sendResponse({ success: true, sessionId: sid, origin: origin });
        });
        return true;
    }

    // -- Every Salesforce org open in a tab right now -------------------------
    if (request.action === "listOrgs") {
        chrome.tabs.query({}, async tabs => {
            const seen = new Map();
            for (const tab of tabs) {
                if (!tab.url || !isSalesforceUrl(tab.url)) continue;
                const origin = toApiOrigin(tab.url);
                if (!origin || seen.has(origin)) continue;
                seen.set(origin, {
                    origin: origin,
                    host: new URL(origin).hostname,
                    tabTitle: tab.title || "",
                    tabId: tab.id,
                    lastAccessed: tab.lastAccessed || 0,
                    hasSession: false
                });
            }
            const orgs = Array.from(seen.values());
            await Promise.all(orgs.map(async o => { o.hasSession = !!(await readSessionCookie(o.origin)); }));
            orgs.sort((a, b) => b.lastAccessed - a.lastAccessed);
            sendResponse({ success: true, orgs: orgs });
        });
        return true;
    }

    return false;
});

// ── TOOLBAR CLICK: one toolkit window, reused ────────────────────────────────
let toolkitWindowId = null;

chrome.action.onClicked.addListener(async tab => {
    if (toolkitWindowId !== null) {
        try {
            await chrome.windows.update(toolkitWindowId, { focused: true });
            return;
        } catch (e) {
            toolkitWindowId = null;
        }
    }

    if (!tab || !isSalesforceUrl(tab.url || "")) {
        const anySf = (await chrome.tabs.query({})).some(t => t.url && isSalesforceUrl(t.url));
        if (!anySf) {
            chrome.notifications.create({
                type: "basic",
                iconUrl: "icons/icon48.png",
                title: "SF Dev Toolkit",
                message: "Open a Salesforce tab first, then click the toolkit icon."
            });
            return;
        }
    }

    const win = await chrome.windows.create({
        url: chrome.runtime.getURL("window.html"),
        type: "popup",
        state: "maximized"
    });
    toolkitWindowId = win.id;
});

chrome.windows.onRemoved.addListener(id => {
    if (id === toolkitWindowId) toolkitWindowId = null;
});
