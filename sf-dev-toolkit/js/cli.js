// =============================================================================
// cli.js — build a one-line `sf org login access-token` command for any shell.
//
// The command is rendered masked. Copy always puts the *real* command on the
// clipboard, so the token never has to sit on screen to be useful.
// =============================================================================

var CLI = {
    shell: "powershell",
    alias: "",
    real: "",       // command with the live token
    masked: "",     // command with the token blanked out
    revealed: false,
    revealTimer: null
};

var SHELLS = {
    powershell: {
        name: "PowerShell",
        os: "Windows (PowerShell 5 / 7)",
        set: function (t) { return "$env:SF_ACCESS_TOKEN='" + t + "'"; },
        join: "; ",
        q: function (v) { return "'" + v + "'"; },
        unset: "Remove-Item Env:SF_ACCESS_TOKEN"
    },
    cmd: {
        name: "Command Prompt",
        os: "Windows (cmd.exe)",
        set: function (t) { return 'set "SF_ACCESS_TOKEN=' + t + '"'; },
        join: " && ",
        q: function (v) { return '"' + v + '"'; },
        unset: "set SF_ACCESS_TOKEN="
    },
    bash: {
        name: "bash / zsh",
        os: "macOS, Linux, WSL",
        set: function (t) { return "export SF_ACCESS_TOKEN='" + t + "'"; },
        join: "; ",
        q: function (v) { return "'" + v + "'"; },
        unset: "unset SF_ACCESS_TOKEN"
    },
    fish: {
        name: "fish",
        os: "any platform running fish",
        set: function (t) { return "set -x SF_ACCESS_TOKEN '" + t + "'"; },
        join: "; and ",
        q: function (v) { return "'" + v + "'"; },
        unset: "set -e SF_ACCESS_TOKEN"
    },
    gitbash: {
        name: "Git Bash",
        os: "Windows (Git Bash / MSYS)",
        set: function (t) { return "export SF_ACCESS_TOKEN='" + t + "'"; },
        join: "; ",
        q: function (v) { return "'" + v + "'"; },
        unset: "unset SF_ACCESS_TOKEN"
    }
};

// ── default shell from the machine we're running on ──────────────────────────
(function detectShell() {
    var ua = navigator.userAgent || "";
    if (/Windows/i.test(ua)) CLI.shell = "powershell";
    else if (/Mac|iPhone|iPad/i.test(ua)) CLI.shell = "bash";
    else CLI.shell = "bash";
})();

function defaultAlias() {
    if (!SFPE.apiBase) return "my-org";
    var host = new URL(SFPE.apiBase).hostname;
    var first = host.split(".")[0];
    return first.replace(/-ed$/, "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "my-org";
}

function buildCommand(token) {
    var sh = SHELLS[CLI.shell];
    var alias = ($("cliAlias").value || defaultAlias()).trim();
    var url = SFPE.apiBase || "https://mydomain.my.salesforce.com";
    var legacy = $("cliLegacy").checked;
    var parts = [];

    parts.push(sh.set(token));

    if (legacy) {
        var lg = "sfdx force:auth:accesstoken:store --instanceurl " + sh.q(url) + " --setalias " + sh.q(alias) + " --noprompt";
        if ($("cliSetDefault").checked) lg += " --setdefaultusername";
        if ($("cliSetDevHub").checked) lg += " --setdefaultdevhubusername";
        parts.push(lg);
        if ($("cliVerify").checked) parts.push("sfdx force:org:display -u " + sh.q(alias));
    } else {
        var cmd = "sf org login access-token --instance-url " + sh.q(url) + " --alias " + sh.q(alias) + " --no-prompt";
        if ($("cliSetDefault").checked) cmd += " --set-default";
        if ($("cliSetDevHub").checked) cmd += " --set-default-dev-hub";
        parts.push(cmd);
        if ($("cliVerify").checked) parts.push("sf org display --target-org " + sh.q(alias));
    }

    return parts.join(sh.join);
}

function renderCli() {
    var sh = SHELLS[CLI.shell];
    $("cliShellName").textContent = sh.name + " · " + sh.os;

    var placeholder = $("cliNoToken").checked;
    var token = placeholder ? "PASTE_SESSION_ID_HERE" : (sessionId || "");

    if (!token) {
        $("cliCommand").textContent = "Connect to an org (or tick the placeholder option) to build the command.";
        $("cliTokenState").textContent = "no session";
        CLI.real = CLI.masked = "";
        renderSnippets();
        renderSteps();
        return;
    }

    CLI.real = buildCommand(token);
    CLI.masked = placeholder ? CLI.real : buildCommand(maskToken(token));

    $("cliCommand").textContent = (CLI.revealed || placeholder) ? CLI.real : CLI.masked;
    $("cliTokenState").textContent = placeholder ? "placeholder" : (CLI.revealed ? "token visible" : "token hidden");
    $("cliTokenState").className = "tag warn";

    $("cliHint").textContent = "Copy puts the full command — real token included — on your clipboard even while it reads masked here. " +
        "Session tokens expire when your browser session does, so re-copy when the CLI starts returning INVALID_SESSION_ID.";

    renderSteps();
    renderSnippets();
}

function renderSteps() {
    var sh = SHELLS[CLI.shell];
    var alias = ($("cliAlias").value || defaultAlias()).trim();
    var steps = [
        "Copy the command above.",
        "Open " + sh.name + " on " + sh.os.split("(")[0].trim() + " and paste it. Nothing is typed twice — the token rides along in the environment variable.",
        "The CLI answers with “Successfully authorized …”. Your org is now saved as <b>" + alias + "</b>" +
            ($("cliSetDefault").checked ? " and set as the default target org." : "."),
        "Work as usual: <code class='mono'>sf project deploy start</code>, <code class='mono'>sf apex run</code>, <code class='mono'>sf data query</code>.",
        "When you're done, clear the variable: <code class='mono'>" + sh.unset + "</code>"
    ];
    var ol = $("cliSteps");
    ol.innerHTML = "";
    steps.forEach(function (s) {
        var li = document.createElement("li");
        li.innerHTML = s;
        ol.appendChild(li);
    });
}

function renderSnippets() {
    var alias = ($("cliAlias").value || defaultAlias()).trim();
    var url = SFPE.apiBase || "https://mydomain.my.salesforce.com";
    var sh = SHELLS[CLI.shell];
    var items = [
        ["Open this org in a browser", "sf org open --target-org " + alias],
        ["Show org details and token", "sf org display --target-org " + alias + " --verbose"],
        ["List every authorised org", "sf org list --all"],
        ["Query records", 'sf data query --target-org ' + alias + ' --query "SELECT Id, Name FROM Account LIMIT 5"'],
        ["Run anonymous Apex from a file", "sf apex run --target-org " + alias + " --file script.apex"],
        ["Tail debug logs", "sf apex tail log --target-org " + alias + " --color"],
        ["Run local tests with coverage", "sf apex run test --target-org " + alias + " --code-coverage --result-format human"],
        ["Retrieve Apex + LWC", "sf project retrieve start --target-org " + alias + " --metadata ApexClass LightningComponentBundle"],
        ["Deploy force-app", "sf project deploy start --target-org " + alias + " --source-dir force-app --test-level RunLocalTests"],
        ["Assign a permission set", "sf org assign permset --name My_Permission_Set --target-org " + alias],
        ["Log out of this org", "sf org logout --target-org " + alias + " --no-prompt"],
        ["Clear the token variable", sh.unset],
        ["Instance url only", url]
    ];

    var wrap = $("cliSnippets");
    wrap.innerHTML = "";
    items.forEach(function (it) {
        var row = document.createElement("div");
        row.className = "snippet";
        var txt = document.createElement("div");
        txt.className = "txt";
        var b = document.createElement("b"); b.textContent = it[0];
        var c = document.createElement("code"); c.className = "mono"; c.textContent = it[1];
        txt.appendChild(b); txt.appendChild(c);
        var btn = document.createElement("button");
        btn.className = "btn mini";
        btn.textContent = "Copy";
        btn.addEventListener("click", function () { copyText(it[1], it[0] + " copied"); });
        row.appendChild(txt); row.appendChild(btn);
        wrap.appendChild(row);
    });
}

// ── wiring ───────────────────────────────────────────────────────────────────
document.querySelectorAll("#shellTabs .tab").forEach(function (t) {
    t.addEventListener("click", function () {
        document.querySelectorAll("#shellTabs .tab").forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        CLI.shell = t.dataset.shell;
        chrome.storage.local.set({ shell: CLI.shell });
        renderCli();
    });
});

["cliSetDefault", "cliSetDevHub", "cliVerify", "cliLegacy", "cliNoToken"].forEach(function (id) {
    $(id).addEventListener("change", renderCli);
});

$("cliAlias").addEventListener("input", function () {
    renderCli();
    if (SFPE.apiBase) {
        var key = "alias:" + new URL(SFPE.apiBase).hostname;
        var payload = {}; payload[key] = $("cliAlias").value;
        chrome.storage.local.set(payload);
    }
});

$("btnCopyCli").addEventListener("click", function () {
    if (!CLI.real) { toast("Connect to an org first — there's no command to copy yet.", true); return; }
    copyText(CLI.real, "Login command copied");
});

$("btnRevealCli").addEventListener("click", function () {
    if (!CLI.real) return;
    clearTimeout(CLI.revealTimer);
    CLI.revealed = !CLI.revealed;
    $("btnRevealCli").textContent = CLI.revealed ? "Hide" : "Reveal 15s";
    renderCli();
    if (CLI.revealed) {
        CLI.revealTimer = setTimeout(function () {
            CLI.revealed = false;
            $("btnRevealCli").textContent = "Reveal 15s";
            renderCli();
        }, 15000);
    }
});

// restore preferences, then draw
chrome.storage.local.get(["shell"], function (d) {
    if (d.shell && SHELLS[d.shell]) {
        CLI.shell = d.shell;
        document.querySelectorAll("#shellTabs .tab").forEach(function (x) {
            x.classList.toggle("active", x.dataset.shell === CLI.shell);
        });
    } else {
        document.querySelectorAll("#shellTabs .tab").forEach(function (x) {
            x.classList.toggle("active", x.dataset.shell === CLI.shell);
        });
    }
    renderCli();
});

SFPE.onReady(function () {
    var host = new URL(SFPE.apiBase).hostname;
    chrome.storage.local.get(["alias:" + host], function (d) {
        $("cliAlias").value = d["alias:" + host] || defaultAlias();
        renderCli();
    });
});

document.addEventListener("sfpe:locked", function () { CLI.real = CLI.masked = ""; renderCli(); });
