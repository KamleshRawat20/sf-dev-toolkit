// =============================================================================
// boot.js — runs last: restore preferences, connect, then reveal the UI.
// =============================================================================

(function boot() {
    var splash = $("splash");
    function done(msg) {
        if (msg) $("splashSub").textContent = msg;
        setTimeout(function () {
            splash.classList.add("gone");
            setTimeout(function () { splash.style.display = "none"; }, 350);
        }, 150);
    }

    chrome.storage.local.get(["theme", "remember"], async function (prefs) {
        applyTheme(prefs.theme === "light" ? "light" : "dark");
        $("rememberSession").checked = !!prefs.remember;

        try {
            var orgs = await refreshOrgList(false);
            var stashed = prefs.remember ? await readStashedSession() : null;

            if (stashed && stashed.origin && stashed.token) {
                $("splashSub").textContent = "Reusing the session you kept…";
                var ok = await connectTo(stashed.origin, stashed.token);
                if (ok) {
                    SFPE.manual = !!stashed.manual;
                    $("orgSelect").value = stashed.origin;
                    return done();
                }
            }

            if (!orgs.length) {
                setStatus("err", "No org detected");
                toast("Open a Salesforce tab, then press Reconnect.", true);
                return done("Open a Salesforce tab, then press Reconnect.");
            }

            var target = orgs.find(function (o) { return o.hasSession; }) || orgs[0];
            $("splashSub").textContent = "Connecting to " + target.host + "…";
            await connectTo(target.origin);
            done();
        } catch (e) {
            setStatus("err", "Startup failed");
            toast("Startup failed: " + e.message, true);
            done("Startup failed — press Reconnect.");
        }
    });

    // Tabs come and go while the toolkit is open; keep the picker honest.
    if (chrome.tabs && chrome.tabs.onRemoved) {
        chrome.tabs.onRemoved.addListener(function () {
            if (SFPE.ready) return;   // don't churn while connected
            refreshOrgList(false);
        });
    }
})();
