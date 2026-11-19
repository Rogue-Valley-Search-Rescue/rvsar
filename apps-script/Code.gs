/**
 * RVSAR photo & video upload backend (Google Apps Script Web App).
 *
 * The website's /upload page POSTs JSON here (as text/plain to avoid a CORS
 * preflight). This script runs as the deploying Google account and streams
 * each file into the configured Drive folder using a Drive resumable upload:
 *
 *   start   validate metadata, open a resumable upload session → uploadId
 *   chunk   forward one piece of the file (base64) into that session
 *   status  ask Drive how many bytes it has (used to resume after an error)
 *
 * Apps Script caps request bodies around 50 MB, so the page sends files in
 * 8 MB pieces; this is what lets large videos through.
 *
 * Secrets are NOT stored in this file (the repo is public). Set them in
 * Apps Script → Project Settings → Script Properties:
 *   UPLOAD_PASSCODE  the password members type on the upload page
 *   FOLDER_ID        the ID of the Drive folder that receives uploads
 *
 * See apps-script/README.md for deployment steps.
 */

// Accepted types → file extensions that match them (first one is used when fixing a name).
const ALLOWED_TYPES = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/heic': ['heic'],
  'image/heif': ['heif', 'heic'],
  'image/webp': ['webp'],
  'video/mp4': ['mp4', 'm4v'],
  'video/quicktime': ['mov'],
  'video/webm': ['webm'],
};

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB; keep in sync with UploadPage.tsx
const MAX_CHUNK_BYTES = 32 * 1024 * 1024; // must stay well under the ~50 MB request cap after base64
const CHUNK_MULTIPLE = 256 * 1024; // Drive requires non-final chunks to be multiples of 256 KB
const SESSION_TTL_SECONDS = 6 * 60 * 60; // CacheService maximum
const TIME_ZONE = 'America/Los_Angeles';

function doGet() {
  return ContentService.createTextOutput('RVSAR upload endpoint is running.');
}

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const passcode = props.getProperty('UPLOAD_PASSCODE');
    const folderId = props.getProperty('FOLDER_ID');
    if (!passcode || !folderId) {
      return reply_(false, 'The upload server is not configured yet.');
    }

    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (_) {
      return reply_(false, 'Malformed request.');
    }

    if (!safeEqual_(String(body.passcode || ''), passcode)) {
      return reply_(false, 'Incorrect password.', { code: 'bad_passcode' });
    }

    switch (body.action) {
      case 'verify':
        return reply_(true);
      case 'start':
        return start_(body, folderId);
      case 'chunk':
        return chunk_(body);
      case 'status':
        return status_(body);
      default:
        return reply_(false, 'Unknown action.');
    }
  } catch (err) {
    console.error(err);
    return reply_(false, 'Upload failed on the server. Please try again.', { retryable: true });
  }
}

/** Validate the upload's metadata and open a Drive resumable upload session. */
function start_(body, folderId) {
  const name = clean_(body.name, 100);
  const event = clean_(body.event, 150);
  const originalName = clean_(body.filename, 200) || 'upload';
  const mimeType = String(body.mimeType || '').toLowerCase();
  const size = Number(body.size);

  if (!name) return reply_(false, 'Your name is required.');
  if (body.permission !== true) return reply_(false, 'Permission must be confirmed.');
  if (!ALLOWED_TYPES[mimeType]) return reply_(false, 'Only photos (JPEG, PNG, HEIC, WebP) and videos (MP4, MOV, WebM) are accepted.');
  if (!Number.isInteger(size) || size <= 0) return reply_(false, 'Invalid file size.');
  if (size > MAX_FILE_BYTES) return reply_(false, 'File is larger than 2 GB.');

  // Using DriveApp here also makes Apps Script request the Drive scope that
  // ScriptApp.getOAuthToken() needs for the upload session below.
  const folder = DriveApp.getFolderById(folderId);

  const fixedName = withExtension_(originalName, mimeType);
  const now = new Date();
  const datePart = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  const filename = [datePart, event, name, fixedName].filter(String).join(' - ');
  const description =
    'Uploaded by: ' + name + '\n' +
    'Event: ' + (event || '(none)') + '\n' +
    'Original filename: ' + originalName + '\n' +
    'Social media permission confirmed: ' + Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm:ss z');

  const res = openSession_(folder.getId(), filename, description, mimeType, size);
  const location = header_(res, 'location');
  if (res.getResponseCode() !== 200 || !location) {
    console.error('Could not start upload', res.getResponseCode(), res.getContentText());
    return reply_(false, 'Could not start the upload (' + driveError_(res) + ').', { retryable: true });
  }

  const uploadId = Utilities.getUuid();
  CacheService.getScriptCache().put(
    'upload:' + uploadId,
    JSON.stringify({ url: location, size: size, mimeType: mimeType }),
    SESSION_TTL_SECONDS
  );
  return reply_(true, null, { uploadId: uploadId });
}

/** Ask Drive for a resumable upload session; the session URL is in the Location header. */
function openSession_(folderId, filename, description, mimeType, size) {
  return UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
    {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(size),
      },
      payload: JSON.stringify({
        name: filename,
        parents: [folderId],
        description: description,
        mimeType: mimeType,
      }),
      muteHttpExceptions: true,
    }
  );
}

/** Short description of a failed Drive API response, e.g. "Drive 403: Insufficient permission". */
function driveError_(res) {
  let message = '';
  try {
    message = JSON.parse(res.getContentText()).error.message;
  } catch (_) {
    message = res.getContentText().slice(0, 200);
  }
  return 'Drive ' + res.getResponseCode() + (message ? ': ' + message : '');
}

/**
 * Diagnostic: run this from the Apps Script editor (select it in the function
 * dropdown, click Run) to check the script can open a Drive upload session.
 * It does not create a file. The result appears in the Execution log.
 */
function testDriveUpload() {
  const folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  console.log('FOLDER_ID property: ' + (folderId ? 'set' : 'MISSING'));
  const folder = DriveApp.getFolderById(folderId);
  console.log('Folder found: ' + folder.getName());
  const res = openSession_(folder.getId(), 'rvsar-upload-test.jpg', 'test', 'image/jpeg', 1000);
  console.log('Drive response code: ' + res.getResponseCode());
  console.log('Session URL received: ' + (header_(res, 'location') ? 'yes' : 'no'));
  if (res.getResponseCode() !== 200) console.log('Drive error: ' + res.getContentText());
}

/** Forward one base64-encoded piece of the file into the Drive session. */
function chunk_(body) {
  const session = getSession_(body.uploadId);
  if (!session) return reply_(false, 'Upload session expired. Please try again.');

  const offset = Number(body.offset);
  if (typeof body.data !== 'string' || !body.data) return reply_(false, 'No file data received.');
  const bytes = Utilities.base64Decode(body.data);
  const end = offset + bytes.length;

  if (!Number.isInteger(offset) || offset < 0 || end > session.size || bytes.length > MAX_CHUNK_BYTES) {
    return reply_(false, 'Invalid upload chunk.');
  }
  if (end < session.size && bytes.length % CHUNK_MULTIPLE !== 0) {
    return reply_(false, 'Invalid upload chunk size.');
  }
  if (offset === 0 && !looksLikeMedia_(bytes, session.mimeType)) {
    CacheService.getScriptCache().remove('upload:' + body.uploadId);
    return reply_(false, 'File does not look like a valid photo or video.');
  }

  const res = UrlFetchApp.fetch(session.url, {
    method: 'put',
    contentType: 'application/octet-stream',
    payload: bytes,
    headers: { 'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + session.size },
    followRedirects: false, // Drive answers 308 "Resume Incomplete" with no Location
    muteHttpExceptions: true,
  });
  return sessionResult_(res, body.uploadId);
}

/** Ask Drive how much of the file it has received (to resume after an error). */
function status_(body) {
  const session = getSession_(body.uploadId);
  if (!session) return reply_(false, 'Upload session expired. Please try again.');

  const res = UrlFetchApp.fetch(session.url, {
    method: 'put',
    headers: { 'Content-Range': 'bytes */' + session.size },
    followRedirects: false,
    muteHttpExceptions: true,
  });
  return sessionResult_(res, body.uploadId);
}

/** Translate a Drive resumable-upload response into a reply for the page. */
function sessionResult_(res, uploadId) {
  const code = res.getResponseCode();
  if (code === 308) {
    const range = header_(res, 'range'); // e.g. "bytes=0-8388607"; absent if nothing stored yet
    const next = range ? Number(range.split('-')[1]) + 1 : 0;
    return reply_(true, null, { done: false, next: next });
  }
  if (code === 200 || code === 201) {
    CacheService.getScriptCache().remove('upload:' + uploadId);
    return reply_(true, null, { done: true, id: JSON.parse(res.getContentText()).id });
  }
  if (code === 404 || code === 410) {
    CacheService.getScriptCache().remove('upload:' + uploadId);
    return reply_(false, 'Upload session expired. Please try again.');
  }
  console.error('Drive upload error', code, res.getContentText());
  return reply_(false, 'Upload failed on the server (' + driveError_(res) + '). Please try again.', { retryable: true });
}

function getSession_(uploadId) {
  if (typeof uploadId !== 'string' || !uploadId) return null;
  const raw = CacheService.getScriptCache().get('upload:' + uploadId);
  return raw ? JSON.parse(raw) : null;
}

function header_(res, name) {
  const headers = res.getAllHeaders();
  for (const key in headers) {
    if (key.toLowerCase() === name) return String(headers[key]);
  }
  return '';
}

function reply_(ok, error, extra) {
  const payload = Object.assign({ ok: ok }, error ? { error: error } : {}, extra || {});
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Make a filename's extension match its real type, e.g. a JPEG named "IMG.heic" → "IMG.jpg". */
function withExtension_(filename, mimeType) {
  const extensions = ALLOWED_TYPES[mimeType];
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (extensions.indexOf(ext) !== -1) return filename;
  return (dot > 0 ? filename.slice(0, dot) : filename) + '.' + extensions[0];
}

/** Strip path separators/control characters and trim to a max length. */
function clean_(value, maxLen) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f\/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** Constant-time string comparison. */
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Check the file's leading "magic bytes" match the claimed type. */
function looksLikeMedia_(bytes, mimeType) {
  if (bytes.length < 12) return false;
  const b = function (i) { return bytes[i] & 0xff; }; // Apps Script bytes are signed
  const ascii = function (start, end) {
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(b(i));
    return s;
  };
  switch (mimeType) {
    case 'image/jpeg':
      return b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
    case 'image/png':
      return b(0) === 0x89 && ascii(1, 4) === 'PNG';
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/heic':
    case 'image/heif':
    case 'video/mp4':
      return ascii(4, 8) === 'ftyp';
    case 'video/quicktime':
      // Modern .mov files start with an ftyp box; older ones with another atom.
      return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].indexOf(ascii(4, 8)) !== -1;
    case 'video/webm':
      return b(0) === 0x1a && b(1) === 0x45 && b(2) === 0xdf && b(3) === 0xa3;
    default:
      return false;
  }
}
