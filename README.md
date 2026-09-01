# Progsu LinkedIn Outreach Assistant

A Chrome extension that speeds up LinkedIn outreach for the Progsu team. It pastes templated messages straight into LinkedIn's chat composer, personalizes them with the recipient's name and company, and tracks who has already been contacted so two people never message the same person twice.

Point every teammate's copy at one Google Sheet and that last part becomes enforced rather than advisory: whoever reaches out first owns the profile, and everyone else is **blocked** from messaging them — see [SETUP-GUIDE.md](SETUP-GUIDE.md).

Built for Hacklanta.

---

## Installation

The extension is not on the Chrome Web Store, so it is loaded unpacked.

1. **Get the code**

   ```bash
   git clone https://github.com/progsu-official/Progsu-Hacklanta-extension.git
   ```

   Or download the ZIP from GitHub and unzip it somewhere permanent — Chrome loads the extension from this folder every launch, so don't leave it in Downloads or a temp directory.

2. **Open the extensions page**

   Go to `chrome://extensions` in Chrome. Edge and Brave work too: `edge://extensions`, `brave://extensions`.

3. **Turn on Developer mode**

   Toggle it in the top-right corner.

4. **Load the extension**

   Click **Load unpacked** and select the `Progsu-Hacklanta-extension` folder — the one containing `manifest.json`. Not a subfolder.

5. **Pin it**

   Click the puzzle-piece icon in the toolbar and pin **Progsu LinkedIn Outreach Assistant** so the popup is one click away.

That's it. No build step, no `npm install`, no dependencies — it's plain JavaScript and loads as-is.

### Set your name first

Open the popup, go to the **Settings** tab, set **Your name**, and hit Save.

Do this before you send anything. Every profile you mark as contacted is stamped with this name — it's what teammates see on the block notice when they land on someone you already messaged. Skip it and everything you send is attributed to "Team Member".

---

## Usage

### Writing templates

Open the popup and go to the **Templates** tab. One template ships by default; edit it or add your own with **New**.

Templates support four placeholders, filled in automatically from the profile you're messaging:

| Placeholder | Becomes |
|---|---|
| `{{firstName}}` | First name |
| `{{lastName}}` | Everything after the first name |
| `{{fullName}}` | Full name as LinkedIn shows it |
| `{{company}}` | Current company from their profile |

Example:

```
Hi {{firstName}},

I came across your profile and was really impressed by your work at
{{company}}. I'd love to connect and explore how we might collaborate.

Looking forward to hearing from you!
```

If a value can't be read off the page, the placeholder is left visible in the message — so you'll catch it before hitting Send rather than shipping a blank.

Mark the template you use most with **Set as default template**. It's the one pre-selected on every new chat.

### Sending

1. Open a LinkedIn profile or a message thread.
2. Click into the message box. A **Progsu** toolbar appears next to the composer.
3. Pick a template from the dropdown.
4. Click **Paste Message**. The text lands in the composer, personalized, with LinkedIn's Send button correctly enabled.
5. Review it, then send it from LinkedIn as normal.
6. Click **Mark Sent** to record the profile as contacted.

If **Auto-paste** is on in Settings, step 4 happens by itself the moment a composer opens.

There's also a **Paste to LinkedIn Chat** button on the popup's Templates tab, which drops your default template into an already-open chat without touching the on-page toolbar.

The extension never clicks Send for you. You always review and send the message yourself.

### Avoiding duplicates

When you open a profile someone on the team has already contacted, a banner appears at the top of the page showing who reached out, when, and with which template. The composer toolbar shows the same warning as a chip.

By default you are also **blocked from messaging them**. The message box stops accepting input, LinkedIn's Send button stops responding, the Message button on their profile stops opening a chat, and auto-paste refuses to fill anything in. A red panel over the composer says who reached out and when.

If you want warnings without the block, turn off **Block duplicate outreach** in Settings and everything reverts to advisory.

You also don't have to open a profile to find out. Anywhere LinkedIn lists people — search results, My Network, your connections, the feed — anyone already contacted gets a small amber badge next to their name showing who reached out:

```
Jane Doe  ✓ Sam
```

Hover it for the full detail: who, when, and which template. The badges appear on results as you scroll and update the moment someone is marked or a teammate's list is imported — no page reload. Turn them off in Settings with **Tag contacted people in search results**.

This only reads the profile links LinkedIn has already drawn on screen. It never scrolls or fetches on its own to harvest more.

The **Contacted** tab in the popup lists everyone recorded, with search. Remove an entry if it was marked by mistake. The header shows counts for today and all-time.

---

## Sharing the contacted list across the team

Point every teammate's copy of Progsu at one Google Sheet and the contacted list becomes shared. Whoever reaches out to a profile first owns the profile, and every other install is blocked from messaging that person — that is the whole point of the setup.

The sheet is already set up. Connecting takes two minutes: paste one link and one password into the popup's **Team Sync** settings — the same two values for everybody.

**→ [SETUP-GUIDE.md](SETUP-GUIDE.md)** has the link and password to paste in, the two-minute connect steps, what every Team Sync button does, and what to do when something goes wrong.

Team Sync is optional. Leave it off and everything stays local, shared by hand with **Export** / **Import** on the Contacted tab.

---

## Settings

| Setting | What it does |
|---|---|
| **Your name** | Stamped on every profile you mark as contacted, so the team can see who did outreach |
| **Auto-paste** | Automatically pastes the default template when a composer opens |
| **Show badge** | Shows the "already contacted" banner on profiles |
| **Tag contacted people in search results** | Adds a badge next to already-messaged people in search, My Network, connections and the feed |
| **Block duplicate outreach** | Refuses to message anyone the team has already contacted. On by default |
| **Team Sync** | URL and token for the shared Google Sheet — see [SETUP-GUIDE.md](SETUP-GUIDE.md) |

| if the extention isnt working reload the page and it will load in on the current page |

---

## Project structure

```
manifest.json          Manifest V3 config, permissions, entry points
README.md              This file — install and day-to-day use
SETUP-GUIDE.md         Team Sync: connecting to the shared Google Sheet
background/
  background.js        Service worker — storage, message routing, sync engine
  sheets.js            Google Sheet client and the merge rules
content/
  content.js           Injected into LinkedIn: composer detection, paste, badges, markers, block guards
  content.css          Styles for the on-page toolbar, banner and block overlay
popup/
  popup.html           Popup UI — Templates / Contacted / Settings tabs
  popup.js             Popup logic
  popup.css            Popup styles
sheets/
  Code.gs              Apps Script to paste into the team's Google Sheet
tests/                 Node test suites — run with `node tests/<name>.test.mjs`
icons/                 16, 48, 128 px extension icons
```

The background worker owns all storage. The content script and popup never touch `chrome.storage` directly — they send messages (`GET_TEMPLATES`, `MARK_CONTACTED`, `CHECK_PROFILE`, and so on) and the worker handles them. Adding a feature that persists something means adding a handler there.

Contacted profiles live in two places: `chrome.storage.local` is a fast cache every UI reads, and the Google Sheet is the team's source of truth. When the two disagree, the **earlier** outreach wins — the question being answered is "has anyone reached out yet?", and the first contact is the answer. `background/sheets.js` holds that rule in one place (`pickWinner`), and the sheet is authoritative on whether a row exists at all, which is how a removal reaches other installs.

---

## Permissions and privacy

The extension requests:

- `storage` — save templates and the contacted list
- `activeTab` and `scripting` — interact with the LinkedIn tab you have open
- `alarms` — schedule the background sync
- `https://www.linkedin.com/*` — run only on LinkedIn
- `https://script.google.com/*` and `https://script.googleusercontent.com/*` — reach your team's Apps Script deployment

**With Team Sync off, nothing leaves your browser.** There is no analytics and no server of ours; the only domain the code touches is `linkedin.com`, and data leaves only when you click Export.

**With Team Sync on**, contacted profiles are sent to *your own* Google Sheet, through *your own* Apps Script deployment. Nothing is routed through any third party. What goes on the sheet is the profile URL, the person's name, the date, who reached out, and which template was used — never message contents. Anyone holding the Web App URL and the token can read and write that sheet, so share both only with the team.

Uninstalling the extension deletes the local templates and contacted list with it. The Google Sheet is unaffected. Export first if you want to keep the local copy.

---

## Troubleshooting

**The toolbar doesn't appear.**
Click directly inside the message box — it attaches to a focused composer. If it still doesn't show, reload the LinkedIn tab.

**"LinkedIn blocked the paste."**
LinkedIn's editor occasionally rejects a programmatic paste when the text cursor isn't in the box. Click inside the composer and press Paste again.

**"No profile link found for this chat."**
Mark Sent needs a profile URL to key the record on, and some message threads don't expose one. Open the person's profile and mark it from there.

**Placeholders show up literally in the sent message.**
The value couldn't be read from the page — common on profiles with no listed company. Fill it in by hand before sending.

**Someone is blocked who shouldn't be.**
Open the **Contacted** tab, find them, and remove the entry. That deletes their row from the team sheet and unblocks them everywhere. To lift blocking entirely, turn off **Block duplicate outreach** in Settings.

**The badges next to names don't appear.**
Check **Tag contacted people in search results** is on in Settings. If it is, the person may be recorded under a different profile URL than the one the list links to — open their profile and check for the banner. Failing that, LinkedIn changed their markup; see `MARKER_EXCLUDE_SELECTOR` in `content.js`.

**Anything to do with Team Sync or the Google Sheet.**
See [If something goes wrong, in SETUP-GUIDE.md](SETUP-GUIDE.md#if-something-goes-wrong) — login pages instead of data, token mismatches, timeouts, blocks that won't lift.

**Changes to the code don't take effect.**
Go to `chrome://extensions` and hit reload on the extension card. Content script changes also need a LinkedIn tab reload.

---

## Development

No toolchain — edit a file, reload the extension at `chrome://extensions`, refresh LinkedIn.

Two things worth knowing before changing `content.js`:

**LinkedIn ships several messaging layouts** — full page, overlay bubble, and the modal launched from a profile. `COMPOSER_SELECTOR` casts a wide net across all of them and filters afterward. If the toolbar stops appearing, LinkedIn changed their markup and that selector list is the first place to look.

**List markers key off `href`, not classes.** `annotateProfileLinks()` finds people by `a[href*="/in/"]` and normalizes the URL, because the `/in/` href is the one part of LinkedIn's markup that survives their redesigns. Two guards there are load-bearing: `data-progsu-marked` stops the MutationObserver from reacting to our own injection in an endless loop, and the row check stops a person being stamped twice when their avatar and name are separate links to the same profile.

**Pasting is deliberately indirect.** LinkedIn's composer is a React-backed `contenteditable`, so setting `innerHTML` alone leaves the Send button disabled — React never sees the change. The paste path dispatches the events LinkedIn's own editor state listens for. Keep that in mind before simplifying it.

**The block is two mechanisms, not one.** A fixed overlay covers the message form and eats the pointer events that would have reached Send; capture-phase `keydown` / `beforeinput` / `paste` / `drop` guards stop anything typed into a box that already has focus. Removing either one leaves a hole. Deletion keys are deliberately allowed through — they can't send anything, and refusing them would strand a draft written before the verdict arrived.

**The block verdict is asynchronous.** `evaluateComposerBlock()` returns a promise and caches the in-flight one, because `composerBlock.blocked` is still `false` while the sheet is being asked. Anything that reads the flag synchronously will paste into a conversation that is about to be sealed — auto-paste awaits the promise for exactly this reason.

### Tests

The sync logic is hard to check by hand, so it has suites that run on plain Node with no dependencies:

```bash
node tests/merge-rules.test.mjs     # key normalization and first-writer-wins
node tests/sheet-backend.test.mjs   # sheets/Code.gs against a fake Sheets API
node tests/cross-install.test.mjs   # two installs + one sheet, end to end
```

`cross-install.test.mjs` is the interesting one: it boots two separate instances of the real `background.js` against a fake `chrome` API and a `fetch` wired to the real `Code.gs`, then checks that outreach logged by one install blocks the other — including offline queueing, removal propagation, and never deleting local history that was never uploaded.

---

## License

Internal Progsu project.
