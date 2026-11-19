import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Camera, CheckCircle2, Film, ImagePlus, Loader2, Lock, RotateCcw, Upload, X, XCircle } from 'lucide-react';

// Google Apps Script web app URL (ends in /exec). Not a secret: the script
// checks the password itself. See apps-script/README.md.
const UPLOAD_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzEFMCLGrV0ChGKzP6eTNkgExr84c5OC3A6vc2Es283xPU4Mi0Po7RWaHklICv1bOOGJA/exec';

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB; keep in sync with apps-script/Code.gs
// Files go up in pieces because Apps Script rejects requests over ~50 MB (and base64 adds ~33%).
// Must be a multiple of 256 KB for Drive's resumable upload.
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 4;
const PASSCODE_KEY = 'rvsar-upload-passcode';
const NAME_KEY = 'rvsar-upload-name';

type Status = 'pending' | 'uploading' | 'done' | 'error';
type Item = { id: string; file: File; mimeType: string; status: Status; progress: number; error?: string; preview?: string };

type ApiResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  retryable?: boolean;
  uploadId?: string;
  done?: boolean;
  next?: number;
};

// An error that should stop this file's upload and be shown to the member.
class UploadError extends Error {
  constructor(message: string, readonly badPasscode = false) {
    super(message);
  }
}

const isConfigured = UPLOAD_ENDPOINT.startsWith('https://');

function storageGet(store: () => Storage, key: string) {
  try { return store().getItem(key) ?? ''; } catch { return ''; }
}
function storageSet(store: () => Storage, key: string, value: string | null) {
  try { value === null ? store().removeItem(key) : store().setItem(key, value); } catch { /* storage unavailable */ }
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);
const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/**
 * Work out a file's type from its first bytes rather than its name or the
 * browser-reported type, which are often wrong (e.g. a JPEG saved as .heic).
 * Mirrors looksLikeMedia_ in apps-script/Code.gs. Returns '' if unsupported.
 */
async function sniffType(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (bytes.length < 12) return '';
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  const box = ascii(4, 8);
  if (box === 'ftyp') {
    const brand = ascii(8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_BRANDS.has(brand)) return 'image/heif';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'avif' || brand === 'avis') return ''; // AVIF isn't accepted
    return 'video/mp4'; // isom, mp41, mp42, M4V, avc1, …
  }
  if (QUICKTIME_ATOMS.has(box)) return 'video/quicktime';
  return '';
}

function readAsBase64(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function callApi(payload: Record<string, unknown>): Promise<ApiResponse> {
  // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
  const res = await fetch(UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return res.json();
}

function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function failure(res: ApiResponse) {
  return new UploadError(res.error ?? 'Upload failed.', res.code === 'bad_passcode');
}

type Meta = { passcode: string; name: string; event: string; permission: boolean };

/**
 * Upload one file through the Apps Script in CHUNK_BYTES pieces. After a network
 * or transient server error, ask the server how much Drive has and resume there.
 */
async function uploadFile(file: File, mimeType: string, meta: Meta, onProgress: (fraction: number) => void) {
  const start = await callApi({ action: 'start', ...meta, filename: file.name, mimeType, size: file.size });
  if (!start.ok || !start.uploadId) throw failure(start);
  const { uploadId } = start;
  const { passcode } = meta;

  let offset = 0;
  let failures = 0;
  while (true) {
    try {
      const data = await readAsBase64(file.slice(offset, offset + CHUNK_BYTES));
      const res = await callApi({ action: 'chunk', passcode, uploadId, offset, data });
      if (!res.ok) {
        if (!res.retryable) throw failure(res);
        throw new Error(res.error);
      }
      if (res.done) return;
      if ((res.next ?? 0) <= offset) throw new Error('No progress');
      offset = res.next!;
      failures = 0;
      onProgress(offset / file.size);
    } catch (err) {
      if (err instanceof UploadError) throw err;
      if (++failures >= MAX_ATTEMPTS) throw new UploadError('Upload kept failing. Check your connection and try again.');
      await sleep(1500 * failures);
      try {
        const status = await callApi({ action: 'status', passcode, uploadId });
        if (status.ok) {
          if (status.done) return;
          offset = status.next ?? offset;
        } else if (!status.retryable) {
          throw failure(status);
        }
      } catch (statusErr) {
        if (statusErr instanceof UploadError) throw statusErr;
        // Still offline; loop around and try the chunk again.
      }
    }
  }
}

export default function UploadPage() {
  const [passcode, setPasscode] = useState(() => storageGet(() => sessionStorage, PASSCODE_KEY));
  const [unlocked, setUnlocked] = useState(false);

  // A remembered passcode is re-checked on the server on the first upload, so trust it for now.
  useEffect(() => {
    if (passcode) setUnlocked(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [gateMessage, setGateMessage] = useState('');

  const lock = () => {
    storageSet(() => sessionStorage, PASSCODE_KEY, null);
    setPasscode('');
    setUnlocked(false);
    setGateMessage('The password has changed. Please enter the new one.');
  };

  return (
    <div className="min-h-screen bg-stone-50 font-sans text-stone-800">
      <header className="bg-emerald-950 text-white">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2 group">
            <div className="w-9 h-9 bg-orange-600 rounded-lg flex items-center justify-center font-bold text-lg shadow-md group-hover:bg-orange-500 transition-colors">
              R
            </div>
            <span className="font-bold text-lg tracking-tight">RVSAR</span>
          </a>
          <a href="/" className="text-sm text-stone-300 hover:text-orange-400 flex items-center gap-1 transition-colors">
            <ArrowLeft size={16} /> Main site
          </a>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-10">
        <div className="flex items-center gap-3 mb-2">
          <Camera className="text-orange-600" size={28} />
          <h1 className="text-3xl font-bold text-emerald-950">Share Team Photos &amp; Videos</h1>
        </div>
        <p className="text-stone-600 mb-8">
          Upload photos and videos from trainings, missions and events for use on RVSAR social media.
        </p>

        {!isConfigured && (
          <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 text-sm">
            The upload endpoint has not been configured yet. Set <code>UPLOAD_ENDPOINT</code> in{' '}
            <code>src/upload/UploadPage.tsx</code>.
          </div>
        )}

        {unlocked ? (
          <UploadForm passcode={passcode} onBadPasscode={() => lock()} />
        ) : (
          <PasscodeGate
            initialError={gateMessage}
            onUnlock={(code) => {
              storageSet(() => sessionStorage, PASSCODE_KEY, code);
              setPasscode(code);
              setUnlocked(true);
            }}
          />
        )}
      </main>
    </div>
  );
}

function PasscodeGate({ onUnlock, initialError }: { onUnlock: (code: string) => void; initialError: string }) {
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(initialError);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value) return;
    setChecking(true);
    setError('');
    try {
      const res = await callApi({ action: 'verify', passcode: value });
      if (res.ok) onUnlock(value);
      else setError(res.error ?? 'Incorrect password.');
    } catch {
      setError('Could not reach the upload server. Check your connection and try again.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-white rounded-2xl shadow-sm border border-stone-200 p-6 sm:p-8">
      <div className="flex items-center gap-2 mb-4 text-emerald-950">
        <Lock size={20} />
        <h2 className="text-lg font-semibold">Members only</h2>
      </div>
      <label htmlFor="passcode" className="block text-sm font-medium text-stone-700 mb-1">
        Password
      </label>
      <input
        id="passcode"
        type="password"
        autoComplete="current-password"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full rounded-lg border border-stone-300 px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-700"
      />
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      <button
        type="submit"
        disabled={checking || !value || !isConfigured}
        className="mt-5 w-full bg-emerald-800 hover:bg-emerald-700 disabled:bg-stone-300 text-white py-3 rounded-full font-medium transition-colors flex items-center justify-center gap-2"
      >
        {checking ? <Loader2 className="animate-spin" size={18} /> : <Lock size={18} />}
        {checking ? 'Checking…' : 'Unlock'}
      </button>
    </form>
  );
}

function UploadForm({ passcode, onBadPasscode }: { passcode: string; onBadPasscode: () => void }) {
  const [name, setName] = useState(() => storageGet(() => localStorage, NAME_KEY));
  const [event, setEvent] = useState('');
  const [permission, setPermission] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  // Warn before closing the tab mid-upload; large videos take a while.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const update = (id: string, patch: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const addFiles = async (fileList: FileList | null) => {
    if (!fileList) return;
    const files = Array.from(fileList);
    if (inputRef.current) inputRef.current.value = '';
    const added: Item[] = [];
    const bad: string[] = [];
    for (const file of files) {
      const mimeType = await sniffType(file).catch(() => '');
      if (!mimeType) bad.push(`${file.name}: not a supported photo or video format`);
      else if (file.size > MAX_FILE_BYTES) bad.push(`${file.name}: larger than 2 GB`);
      else
        added.push({
          id: crypto.randomUUID(),
          file,
          mimeType,
          status: 'pending',
          progress: 0,
          // Most browsers cannot render HEIC; videos get an icon instead of a thumbnail.
          preview: mimeType.startsWith('image/') && !mimeType.startsWith('image/hei') ? URL.createObjectURL(file) : undefined,
        });
    }
    setItems((prev) => [...prev, ...added]);
    setRejected(bad);
  };

  const remove = (item: Item) => {
    if (item.preview) URL.revokeObjectURL(item.preview);
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  };

  const toUpload = items.filter((i) => i.status === 'pending' || i.status === 'error');
  const doneCount = items.filter((i) => i.status === 'done').length;
  const canSubmit = !busy && name.trim() && permission && toUpload.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    storageSet(() => localStorage, NAME_KEY, name.trim());
    setBusy(true);
    const meta = { passcode, name: name.trim(), event: event.trim(), permission };
    for (const [index, item] of toUpload.entries()) {
      setProgress({ current: index + 1, total: toUpload.length });
      update(item.id, { status: 'uploading', progress: 0, error: undefined });
      try {
        await uploadFile(item.file, item.mimeType, meta, (progress) => update(item.id, { progress }));
        update(item.id, { status: 'done', progress: 1 });
      } catch (err) {
        if (err instanceof UploadError && err.badPasscode) {
          setBusy(false);
          onBadPasscode();
          return;
        }
        const message = err instanceof UploadError ? err.message : 'Network error. Try again.';
        update(item.id, { status: 'error', error: message });
      }
    }
    setBusy(false);
  };

  const clearDone = () => {
    items.filter((i) => i.status === 'done').forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
    setItems((prev) => prev.filter((i) => i.status !== 'done'));
  };

  return (
    <form onSubmit={submit} className="bg-white rounded-2xl shadow-sm border border-stone-200 p-6 sm:p-8 space-y-6">
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-stone-700 mb-1">
            Your name <span className="text-orange-600">*</span>
          </label>
          <input
            id="name"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-stone-300 px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-700"
          />
        </div>
        <div>
          <label htmlFor="event" className="block text-sm font-medium text-stone-700 mb-1">
            Event or training
          </label>
          <input
            id="event"
            placeholder="e.g. Rope rescue training"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            className="w-full rounded-lg border border-stone-300 px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-700"
          />
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="w-full border-2 border-dashed border-stone-300 hover:border-emerald-700 rounded-xl py-8 flex flex-col items-center gap-2 text-stone-600 hover:text-emerald-800 transition-colors"
        >
          <ImagePlus size={32} />
          <span className="font-medium">Choose photos or videos</span>
          <span className="text-xs text-stone-500">Photos: JPEG, PNG, HEIC, WebP · Videos: MP4, MOV, WebM · up to 2 GB each</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*,.heic,.heif,.mov,.m4v"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        {rejected.length > 0 && (
          <ul className="mt-2 text-sm text-red-700 space-y-1">
            {rejected.map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
      </div>

      {items.length > 0 && (
        <ul className="divide-y divide-stone-100 border border-stone-200 rounded-xl">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 p-3">
              <div className="w-12 h-12 rounded-md bg-stone-100 overflow-hidden flex-shrink-0 flex items-center justify-center">
                {item.preview ? (
                  <img src={item.preview} alt="" className="w-full h-full object-cover" />
                ) : item.mimeType.startsWith('video/') ? (
                  <Film size={20} className="text-stone-400" />
                ) : (
                  <Camera size={20} className="text-stone-400" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{item.file.name}</p>
                <p className={`text-xs ${item.status === 'error' ? 'text-red-700' : 'text-stone-500'}`}>
                  {item.status === 'error'
                    ? item.error
                    : item.status === 'uploading' && item.file.size > CHUNK_BYTES
                      ? `${Math.round(item.progress * 100)}% of ${formatSize(item.file.size)}`
                      : formatSize(item.file.size)}
                </p>
                {item.status === 'uploading' && item.file.size > CHUNK_BYTES && (
                  <div className="mt-1 h-1.5 rounded-full bg-stone-100 overflow-hidden">
                    <div className="h-full bg-emerald-700 transition-all" style={{ width: `${item.progress * 100}%` }} />
                  </div>
                )}
              </div>
              {item.status === 'uploading' && <Loader2 className="animate-spin text-emerald-700" size={20} />}
              {item.status === 'done' && <CheckCircle2 className="text-emerald-700" size={20} />}
              {item.status === 'error' && <XCircle className="text-red-600" size={20} />}
              {(item.status === 'pending' || item.status === 'error') && !busy && (
                <button
                  type="button"
                  onClick={() => remove(item)}
                  aria-label={`Remove ${item.file.name}`}
                  className="p-1 text-stone-400 hover:text-stone-700"
                >
                  <X size={18} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <label className="flex items-start gap-3 text-sm text-stone-700">
        <input
          type="checkbox"
          checked={permission}
          onChange={(e) => setPermission(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-emerald-800"
        />
        <span>
          I took these photos and videos (or have the photographer's permission) and RVSAR may post them on its
          website and social media.
        </span>
      </label>

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full bg-orange-600 hover:bg-orange-500 disabled:bg-stone-300 text-white py-3 rounded-full font-medium transition-colors flex items-center justify-center gap-2"
      >
        {busy ? <Loader2 className="animate-spin" size={18} /> : toUpload.some((i) => i.status === 'error') ? <RotateCcw size={18} /> : <Upload size={18} />}
        {busy
          ? `Uploading ${progress.current} of ${progress.total}…`
          : toUpload.some((i) => i.status === 'error')
            ? `Retry ${toUpload.length} file${toUpload.length === 1 ? '' : 's'}`
            : `Upload ${toUpload.length || ''} file${toUpload.length === 1 ? '' : 's'}`}
      </button>

      {!busy && doneCount > 0 && toUpload.length === 0 && (
        <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-emerald-900 text-sm flex items-center justify-between gap-4">
          <span>
            {doneCount} file{doneCount === 1 ? '' : 's'} uploaded. Thank you!
          </span>
          <button type="button" onClick={clearDone} className="font-medium underline hover:text-emerald-700">
            Upload more
          </button>
        </div>
      )}
    </form>
  );
}
