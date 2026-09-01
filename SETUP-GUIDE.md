# Team Sync — Setup Guide

**In plain English:** normally each person's copy of the extension only remembers who *they* messaged. Team Sync puts everyone's list in one Google Sheet instead, so nobody messages the same person twice.

Once it's on:

- Sam messages Jane Doe and clicks **Mark Sent**.
- Two minutes later you open Jane's profile.
- The extension shows *"Sam already reached out"* and won't let you message her.

That's the whole idea. The Google Sheet is just where the shared list is kept.

> **Install the extension first.** See [README.md](README.md). This guide assumes it's already loaded in your browser.

---

## What you need

The sheet is already set up and running. You don't have to create anything — just copy these two values into the extension.

| What | Value |
|---|---|
| **Link** (Web App URL) | `https://script.google.com/macros/s/AKfycbywiyShG8QKRJQNMBoeOeJdv7s6SAOsmem99L7RTHrUlYaJHKU55rBjcxvVtppC2L59/exec` |
| **Password** (Shared Token) | `1234` |

**Everyone on the team uses these same two values.** That's what makes the list shared — if you pointed at a different sheet, your outreach wouldn't reach anyone else and theirs wouldn't reach you.

Keep them inside the team. Anyone with both can read and change the list.

---

## Connect the extension (2 minutes)

Do this once on every computer you use.

1. Click the Progsu icon in your browser toolbar to open the popup.
2. Go to the **Settings** tab.
3. Type your name in **Your name** and click **Save Settings**.
   *This is the name teammates see next to people you've messaged. Skip it and you show up as "Team Member".*
4. Scroll down to **Team Sync**.
5. Paste the **link** into **Apps Script Web App URL**.
6. Type the **password** `1234` into **Shared Token**.
7. Tick the **Use the team sheet** checkbox.
8. Click **Test Connection**.
   - ✅ You should see green text like *"Connected — 14 profiles in the sheet."*
   - ❌ Amber text instead? Go to [If something goes wrong](#if-something-goes-wrong). The message tells you what's broken.
9. Click **Save Sync Settings**.

**How you know it worked:** the little pill next to the "Team Sync" heading flips from **Off** to **On**, and the status line says *"Last synced ..."* with a time.

### One extra step if you used the extension before

Already have people in your **Contacted** tab from before you connected? Click **Upload My List** to copy them up, so your teammates get blocked from those people too.

It says something like *"Uploaded 9 new, 5 already on the sheet."* The "already on the sheet" ones aren't errors — a teammate logged them first. Pressing the button twice is harmless.

**You're done.** Nothing else to do — keep using the extension as normal.

---

## Using it day to day

**Short version: you don't do anything differently.** Use the extension exactly as before. The sharing happens quietly in the background.

| What you do | What happens behind the scenes |
|---|---|
| Open someone's profile | The extension checks the sheet right then. If a teammate messaged them, you get a banner with their name and the message box locks. |
| Browse search results or My Network | Anyone already contacted gets a small badge by their name, like `✓ Sam`. |
| Click **Mark Sent** | Saved on your computer, then added to the sheet straight away — teammates are blocked within seconds. |
| Remove someone from the **Contacted** tab | Their row is deleted from the sheet, which unblocks them for everybody. |
| Click **Clear All** | Only wipes *your* copy. The sheet is untouched, and the next sync brings it all back. |
| Work offline | Your marks are saved and queued. They upload by themselves once you're back online. |

**If two of you mark the same person at the same second,** the sheet keeps whoever got there first and tells the other person who beat them. You never end up with duplicates.

Every 5 minutes the extension quietly downloads the latest list in the background.

---

## The Team Sync buttons

All of these live in the popup under **Settings → Team Sync**.

| Button | What it's for | Press it when |
|---|---|---|
| **Test Connection** | Checks the link and password work. Saves nothing | You're setting up, or something looks broken |
| **Save Sync Settings** | Saves the link, password and checkbox, then syncs | After typing in the link and password |
| **Sync Now** | Fetches the latest list right away instead of waiting 5 minutes | A teammate says they just marked someone and you don't see it |
| **Upload My List** | Copies your existing contacts up to the sheet | Once, when you first connect, if you already had contacts |

**The status line** under those buttons tells you how things are:

| It says | Meaning |
|---|---|
| *Last synced 2:14 PM* | All good |
| *Not connected — this install keeps its contacted list to itself* | Team Sync is off |
| *3 waiting to upload* | Three of your marks haven't reached the sheet yet. Nothing is lost — they go up automatically |
| Amber text | Something's wrong, and the text says what. See below |

**Want to turn it off?** Untick **Use the team sheet** and save. You go back to a private list. Your link and password stay saved, so you can tick it back on any time.

---

## If something goes wrong

**It says "Bad or missing token."**
The password doesn't match. It's `1234` — check for a stray space at the start or end, and make sure nothing else got pasted into the box.

**It says "Got a Google login page instead of data."**
The link is wrong. Copy it again from [What you need](#what-you-need) — the whole thing, ending in `/exec`.

**It says "Sheet did not answer in time."**
Google puts the script to sleep when it's unused, and the call that wakes it can time out. Press **Sync Now** again. If it keeps failing, don't worry — your marks are saved and queued, and they upload once it works.

**Test Connection works, but nothing syncs.**
The **Use the team sheet** checkbox probably isn't ticked — the pill by the heading still says **Off**. Tick it, then **Save Sync Settings**.

**Someone is blocked who shouldn't be.**
Popup → **Contacted** tab → find them → remove them. That deletes their row from the sheet and unblocks them for the whole team.

**A block won't go away after a teammate removed someone.**
The extension remembers the answer for 30 seconds. Wait a moment, or press **Sync Now**.

**My teammate's marks never show up.**
You're probably on different links. Compare your **Apps Script Web App URL** with theirs, character for character — both should match the link above exactly.

**Two rows for the same person in the sheet.**
Someone hand-edited the Profile URL column. Delete the odd-looking row; the extension will find the good one.

---

## What's actually in the sheet

You can open the spreadsheet any time — it's a normal Google Sheet with a tab called **Outreach**:

| Column | What it holds |
|---|---|
| Profile URL | The person's LinkedIn address. This is how everyone is matched up |
| Name | Their name |
| Date Contacted | When they were *first* messaged. Never changes afterwards |
| Contacted By | The **Your name** setting of whoever messaged them |
| Template Used | Which message template was used |
| Last Updated | Housekeeping — ignore it |

Deleting a row by hand unblocks that person for everyone. **Don't edit the Profile URL column** — that's the one thing that breaks the matching. Everything else is safe to tidy up.

Message contents are never stored. Only the six columns above.

---

## Don't want to use a sheet at all?

Team Sync is optional. Leave it switched off and the extension keeps your contacted list on your own computer, exactly as it does out of the box — you just won't be sharing with, or blocked by, anyone else. You can still share by hand with **Export** and **Import** on the **Contacted** tab: importing merges the two lists rather than overwriting, and where the same person is in both, the earlier date is kept.

---

# Reference

Nothing below is needed to use Team Sync. It's here so the setup isn't a black box.

## Appendix A — how the sheet was built

This was done once, and the result is the link at the top of this guide. **You don't need to repeat it.** It's written down in case the sheet ever has to be rebuilt, or someone wants to run a second, separate one for a different team.

1. **Make a spreadsheet** — [sheets.new](https://sheets.new), named "Progsu Outreach". No columns or headings; the script adds those itself.
2. **Open the script editor** — in the sheet, **Extensions → Apps Script**. A tab opens with a starter `myFunction()`.
3. **Paste in the code** — select all the starter code, delete it, then copy the whole of [`sheets/Code.gs`](sheets/Code.gs) into the empty box and save (`Ctrl+S`).
4. **Set the password** — the line near the top reads `var SHARED_TOKEN = '1234';`. That `1234` is the password everyone types into the extension; the two must match exactly.
5. **Publish it** — **Deploy → New deployment**, ⚙️ gear next to "Select type" → **Web app**, then:

   | Box | Value |
   |---|---|
   | Description | anything, e.g. `v1` |
   | Execute as | **Me** |
   | Who has access | **Anyone** |

   "Anyone" is required: the extension calls the link without a Google login, so anything stricter returns a sign-in page instead of data. The password is what gates access.

6. **Give it permission** — **Authorize access**, pick the account, then on the "Google hasn't verified this app" screen click **Advanced → Go to \<project name\> (unsafe) → Allow**. Normal for a private script you wrote yourself.
7. **Copy the link** — the **Web app** URL ending in `/exec`. That's the link at the top of this guide. A `/dev` URL is the wrong one; it only works for the owner.
8. **Test it** — open this in a browser tab:

   ```
   https://script.google.com/macros/s/AKfycb....../exec?action=ping&token=1234
   ```

   `{"ok":true,"action":"ping","sheet":"Outreach","rows":0}` means it's live.

**Editing the code later:** saving isn't enough — Google keeps serving the last published version. Publish an edit with **Deploy → Manage deployments → ✏️ pencil → Version: New version → Deploy**. The link stays the same, so nobody has to re-paste anything.

## Appendix B — for developers

Skip this unless you want to poke at the list from a terminal. The extension does all of it for you.

The script is a small JSON API. Every call needs `token`; `GET` (query string) and `POST` (JSON body) both work.

| Action | Does | Example |
|---|---|---|
| `ping` | Health check and row count | `?action=ping&token=1234` |
| `list` | Everything, keyed by profile URL. Optional `since` (ISO date) for only-what-changed | `?action=list&token=1234` |
| `check` | Has one profile been contacted, and by whom | `?action=check&token=1234&profileUrl=https://www.linkedin.com/in/janedoe` |
| `mark` | Log one profile. First writer wins — a repeat returns `duplicate: true` and leaves the original alone | POST `{"action":"mark","token":"1234","profileUrl":"...","name":"Jane Doe","sentBy":"Sam","templateUsed":"Intro"}` |
| `bulk` | Log many at once, same first-writer-wins rule per row. Powers **Upload My List** | POST `{"action":"bulk","token":"1234","entries":{"<url>":{"name":"...","sentBy":"..."}}}` |
| `remove` | Delete a row, unblocking that person for everyone | `?action=remove&token=1234&profileUrl=...` |

Responses are always JSON with an `ok` flag; failures come back as `{"ok":false,"error":"..."}` with HTTP 200, not an error status.

Writes run under a script lock, so two simultaneous marks produce one row, not two.

Marking someone by hand:

```bash
curl -L -X POST "https://script.google.com/macros/s/AKfycbywiyShG8QKRJQNMBoeOeJdv7s6SAOsmem99L7RTHrUlYaJHKU55rBjcxvVtppC2L59/exec" \
  -H "Content-Type: application/json" \
  -d '{"action":"mark","token":"1234",
       "profileUrl":"https://www.linkedin.com/in/janedoe",
       "name":"Jane Doe","sentBy":"Sam","templateUsed":"Intro"}'
```

`-L` is required — Apps Script replies with a redirect to `script.googleusercontent.com`, and the body only arrives on the second hop.

Profile URLs are stored normalized: `https://www.linkedin.com/in/<slug>`, lowercased. `normalizeUrl()` in [`sheets/Code.gs`](sheets/Code.gs) has to stay in step with `normalizeProfileUrl()` in [`content/content.js`](content/content.js), or the same person ends up with two rows.

---

Anything about the extension itself — templates, badges, blocking, the toolbar — is in [README.md](README.md).
