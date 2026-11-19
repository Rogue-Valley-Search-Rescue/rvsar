# Photo & video upload backend (Google Apps Script)

The site's `/upload` page sends photos and videos to a Google Apps Script web
app, which saves them into a Google Drive folder. Apps Script rejects requests
over about 50 MB, so the page sends each file in 8 MB pieces and the script
forwards them into a Drive resumable upload. Files can be up to 2 GB.

GitHub Pages is static, so this script is the only server-side piece. Nothing
in this folder is deployed by the GitHub Pages workflow; it is kept here as the
source of truth for the script.

## One-time setup

1. Sign in to the Google account that owns (or can edit) the destination Drive
   folder. Uploaded files will be owned by this account and count against its
   storage.
2. Copy the folder ID from its URL:
   `https://drive.google.com/drive/folders/<FOLDER_ID>`.
3. Go to <https://script.google.com>, click **New project**, name it
   "RVSAR Photo Upload", and replace the contents of `Code.gs` with
   [`Code.gs`](Code.gs) from this folder.
4. **Project Settings** (gear icon) → tick **Show "appsscript.json" manifest
   file in editor**. Back in the editor, open `appsscript.json` and replace
   its contents with [`appsscript.json`](appsscript.json) from this folder.
   This requests full Drive access explicitly; without it Apps Script infers
   read-only access (the script only *reads* via `DriveApp`) and uploads fail
   with "insufficient authentication scopes".
5. **Project Settings** (gear icon) → **Script Properties** → add:
   - `UPLOAD_PASSCODE` = the password members will type
   - `FOLDER_ID` = the folder ID from step 2
6. **Deploy → New deployment** → type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Click **Authorize access**. Google will warn "Google hasn't verified this
   app"; choose **Advanced → Go to RVSAR Photo Upload (unsafe)** and allow
   both permissions: Google Drive, and "Connect to an external service" (used
   to send file pieces to Drive's upload API). It is your own script, so the
   warning is expected.
8. Copy the **Web app URL** (ends in `/exec`) and set `UPLOAD_ENDPOINT` in
   [`src/upload/UploadPage.tsx`](../src/upload/UploadPage.tsx) to it.
9. Turn off "Anyone with the link can add" on the Drive folder; the script
   writes as you, so public edit access is no longer needed.

## Changing the password

Edit the `UPLOAD_PASSCODE` script property. No redeploy is needed.

## Changing the size limit

Change `MAX_FILE_BYTES` in both `Code.gs` and `src/upload/UploadPage.tsx`.

## Updating the script

After editing code in the Apps Script editor, go to **Deploy → Manage
deployments → (pencil) Edit → Version: New version → Deploy**. This keeps the
same `/exec` URL. Creating a *new deployment* instead gives a new URL, which
would then have to be updated on the website. If the new code needs a new
permission, Google asks you to authorize again when you deploy.
