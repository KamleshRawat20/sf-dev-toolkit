# SF Dev Toolkit v2

A rebuild of the SF Permission Explorer: same permission auditing, plus CLI
authentication, SOQL, anonymous Apex, a REST explorer, debug logs, org limits
and the small conversions you do all day.

## Install

1. Unzip the folder somewhere permanent (the browser loads it from that path).
2. Chrome → `chrome://extensions` → turn on **Developer mode**.
3. **Load unpacked** → pick this folder.
4. Open any Salesforce tab, click the toolbar icon (or press `Alt+Shift+S`).

## What's in it

**Org & session** — every Salesforce org open in your browser appears in the
switcher at the top; pick one and the whole toolkit points at it. Org name, id,
edition, instance, your user and profile, plus twenty Setup shortcuts.

**CLI login** — the headline feature. Pick your shell and copy one line:

```
$env:SF_ACCESS_TOKEN='…'; sf org login access-token --instance-url '…' --alias 'my-org' --no-prompt --set-default
```

- Five shells: PowerShell, CMD, bash/zsh, fish, Git Bash. macOS, Linux, WSL and
  Windows all covered; the right tab is preselected from your OS.
- Checkboxes for `--set-default`, `--set-default-dev-hub`, a trailing
  `sf org display` verification, legacy `sfdx force:auth:accesstoken:store`
  syntax, and a placeholder mode that leaves the token out entirely.
- Alias defaults from the org's my-domain and is remembered per org.
- A dozen more ready-made commands for that alias: deploy, retrieve, run tests,
  tail logs, assign a permission set, log out.

**Permissions** — objects and fields, plus Apex classes, VF pages, LWC, Aura,
flows, apps, tabs, connected apps, custom permissions, record types and system
permissions. Every row is a live toggle with a Save button; export any table to
CSV or Excel.

**User access** — pick users and objects, get the effective field access with a
"granted by" breakdown showing which profile or permission set is responsible.

**SOQL** — twelve starter queries, Tooling and queryAll switches, auto-pagination,
CSV/TSV export. `Ctrl/⌘ + Enter` runs.

**Apex** — anonymous execution with compile errors, exceptions and the
`USER_DEBUG` lines from the resulting log.

**REST** — any method against any path on the instance.

**Debug logs** — last 50, filter lines, copy, bulk delete.

**Limits** — every limit with a usage bar; anything past 80% turns red.

**Utilities** — 15 ↔ 18 id conversion, key-prefix lookup, open a record or object
by id, clear the describe cache.

`Alt` + a number jumps between views.

## How the session token is handled

- It is read from the org's `sid` cookie by the service worker and held in the
  toolkit window's memory.
- It is **never** written to disk, never synced, never logged, and never sent
  anywhere except the org it came from — `background.js` rejects any request url
  that isn't a Salesforce host before it is sent.
- On screen it renders masked (`00D…!••••`). Reveal is a deliberate 15-second
  action. Copy buttons put the real value on the clipboard without showing it.
- **Keep this session** is opt-in and uses `chrome.storage.session`: browser
  memory, readable by extension pages only, wiped when Chrome quits. Leave it off
  and the token dies with the window.
- **Lock** forgets it immediately. **Wipe clipboard** overwrites whatever you
  copied.
- Treat a copied token exactly like a password: it is full org access as you,
  until your browser session expires. Don't paste it into chats, tickets or logs.

## Changes from v1 worth knowing

- `content.js` and `inject.js` are gone. The old content script was the popup's
  code injected into every Salesforce page, and it saved the session id into the
  page's `localStorage` — readable by anything else running there. Sessions now
  come from the cookie API in the background worker instead, so nothing is
  injected into your org pages and the `scripting` and `activeTab` permissions
  are no longer requested.
- The API version is no longer hardcoded to v59.0. It is discovered from the org
  and selectable in the header.
- All SOQL string interpolation is escaped, so object and user names containing
  quotes no longer break queries.
- Errors surface as readable messages instead of `alert("API failed")`.
