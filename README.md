# Progsu LinkedIn Outreach Assistant

A Chrome extension that speeds up LinkedIn outreach for the Progsu team. It pastes templated messages straight into LinkedIn's chat composer, personalizes them with the recipient's name and company, and tracks who has already been contacted so two people never message the same person twice.

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

Do this before you send anything. Every profile you mark as contacted is stamped with this name, so when the team merges lists later you can tell who reached out to whom. Skip it and everything you send is attributed to "Team Member".

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

Nothing is blocked — you can still message them. It just makes sure it's a deliberate choice.

You also don't have to open a profile to find out. Anywhere LinkedIn lists people — search results, My Network, your connections, the feed — anyone already contacted gets a small amber badge next to their name showing who reached out:

```
Jane Doe  ✓ Sam
```

Hover it for the full detail: who, when, and which template. The badges appear on results as you scroll and update the moment someone is marked or a teammate's list is imported — no page reload. Turn them off in Settings with **Tag contacted people in search results**.

This only reads the profile links LinkedIn has already drawn on screen. It never scrolls or fetches on its own to harvest more.

The **Contacted** tab in the popup lists everyone recorded, with search. Remove an entry if it was marked by mistake. The header shows counts for today and all-time.

---

## Sharing the contacted list across the team

This is the part that matters most for group outreach. Storage is local to each browser, so the list does **not** sync automatically. You have to pass it around.

**To share yours:** Popup → **Contacted** tab → **Export**. You get JSON. Drop it in the team chat or a shared drive.

**To pull in a teammate's:** Popup → **Contacted** tab → **Import** → paste the JSON → confirm.

Import **merges** rather than overwrites, so importing someone else's list never wipes your own. Where the same profile appears in both, the imported entry wins.

A reasonable rhythm: everyone exports at the end of a session, one person merges them all, and posts the combined file for the team to import before the next push.

---

## Settings

| Setting | What it does |
|---|---|
| **Your name** | Stamped on every profile you mark as contacted, so the team can see who did outreach |
| **Auto-paste** | Automatically pastes the default template when a composer opens |
| **Show badge** | Shows the "already contacted" banner on profiles |
| **Tag contacted people in search results** | Adds a badge next to already-messaged people in search, My Network, connections and the feed |

| if the extention isnt working reload the page and it will load in on the current page |

---

## Project structure

```
manifest.json          Manifest V3 config, permissions, entry points
background/
  background.js        Service worker — storage and message routing
content/
  content.js           Injected into LinkedIn: composer detection, paste, badges, list markers
  content.css          Styles for the on-page toolbar and banner
popup/
  popup.html           Popup UI — Templates / Contacted / Settings tabs
  popup.js             Popup logic
  popup.css            Popup styles
icons/                 16, 48, 128 px extension icons
```

The background worker owns all storage. The content script and popup never touch `chrome.storage` directly — they send messages (`GET_TEMPLATES`, `MARK_CONTACTED`, `CHECK_PROFILE`, and so on) and the worker handles them. Adding a feature that persists something means adding a handler there.

---

## Permissions and privacy

The extension requests four things, and nothing more:

- `storage` — save templates and the contacted list
- `activeTab` and `scripting` — interact with the LinkedIn tab you have open
- `https://www.linkedin.com/*` — run only on LinkedIn

**All data stays in your browser.** There is no backend, no analytics, and no external server — the only domain the code touches is `linkedin.com`. Nothing is transmitted anywhere. Data leaves your machine only when you explicitly click Export.

Uninstalling the extension deletes the templates and contacted list with it. Export first if you want to keep them.

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

**The badges next to names don't appear.**
Check **Tag contacted people in search results** is on in Settings. If it is, the person may be recorded under a different profile URL than the one the list links to — open their profile and check for the banner. Failing that, LinkedIn changed their markup; see `MARKER_EXCLUDE_SELECTOR` in `content.js`.

**Changes to the code don't take effect.**
Go to `chrome://extensions` and hit reload on the extension card. Content script changes also need a LinkedIn tab reload.

---

## Development

No toolchain — edit a file, reload the extension at `chrome://extensions`, refresh LinkedIn.

Two things worth knowing before changing `content.js`:

**LinkedIn ships several messaging layouts** — full page, overlay bubble, and the modal launched from a profile. `COMPOSER_SELECTOR` casts a wide net across all of them and filters afterward. If the toolbar stops appearing, LinkedIn changed their markup and that selector list is the first place to look.

**List markers key off `href`, not classes.** `annotateProfileLinks()` finds people by `a[href*="/in/"]` and normalizes the URL, because the `/in/` href is the one part of LinkedIn's markup that survives their redesigns. Two guards there are load-bearing: `data-progsu-marked` stops the MutationObserver from reacting to our own injection in an endless loop, and the row check stops a person being stamped twice when their avatar and name are separate links to the same profile.

**Pasting is deliberately indirect.** LinkedIn's composer is a React-backed `contenteditable`, so setting `innerHTML` alone leaves the Send button disabled — React never sees the change. The paste path dispatches the events LinkedIn's own editor state listens for. Keep that in mind before simplifying it.

---

## License

Internal Progsu project.
