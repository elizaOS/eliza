/**
 * Provides SSR-safe attachment naming, download, and sharing across browser,
 * desktop, and Capacitor transports. Native capabilities are read from the
 * optional global bridge because the Capacitor SDK is not a package dependency.
 */

/* ── File System Access API (Chromium; not yet in the DOM lib) ─────────── */

declare global {
  interface Window {
    showSaveFilePicker?: (opts: { suggestedName?: string }) => Promise<{
      createWritable: () => Promise<{
        write: (data: Blob) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  }
}

/* ── Capacitor global bridge (structural, dependency-free) ─────────────── */

interface CapacitorShareLike {
  share(options: {
    url?: string;
    title?: string;
    text?: string;
    files?: string[];
  }): Promise<unknown>;
}

interface CapacitorFilesystemLike {
  writeFile(options: {
    path: string;
    data: string;
    directory?: string;
  }): Promise<{ uri?: string }>;
  getUri?(options: {
    path: string;
    directory?: string;
  }): Promise<{ uri?: string }>;
}

interface CapacitorPluginsLike {
  Share?: CapacitorShareLike;
  Filesystem?: CapacitorFilesystemLike;
  [key: string]: unknown;
}

interface CapacitorLike {
  isNativePlatform?: () => boolean;
  Plugins?: CapacitorPluginsLike;
}

/** Read the Capacitor global without ever importing the SDK. SSR-safe. */
function getCapacitor(): CapacitorLike | undefined {
  if (typeof globalThis === "undefined") return undefined;
  const cap = (globalThis as { Capacitor?: unknown }).Capacitor;
  if (cap && typeof cap === "object") return cap as CapacitorLike;
  return undefined;
}

function getCapacitorShare(): CapacitorShareLike | undefined {
  const share = getCapacitor()?.Plugins?.Share;
  return share && typeof share.share === "function" ? share : undefined;
}

function getCapacitorFilesystem(): CapacitorFilesystemLike | undefined {
  const fs = getCapacitor()?.Plugins?.Filesystem;
  return fs && typeof fs.writeFile === "function" ? fs : undefined;
}

function isNativePlatform(): boolean {
  const cap = getCapacitor();
  try {
    return cap?.isNativePlatform?.() === true;
  } catch {
    // error-policy:J3 an exotic host global shape reads as "not native".
    return false;
  }
}

/* ── Filename derivation ──────────────────────────────────────────────── */

/**
 * Small mime → extension map for deriving a sensible filename when none is
 * provided. Intentionally compact; unknown types fall back to `.bin`.
 */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/ogg": "ogv",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/opus": "opus",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/html": "html",
};

/** Extension for a mime type, or `bin` for unknown / empty. */
export function extForMime(mime: string): string {
  const normalized = (mime || "").split(";")[0].trim().toLowerCase();
  return MIME_EXT[normalized] ?? "bin";
}

/**
 * Derive a filename from a mime type.
 *
 * - If `base` already carries the correct extension, it is returned as-is.
 * - If `base` is given without an extension, the mime-derived extension is
 *   appended.
 * - With no `base`, returns `download.<ext>`.
 */
export function filenameForMime(mime: string, base?: string): string {
  const ext = extForMime(mime);
  const trimmed = base?.trim();
  if (!trimmed) return `download.${ext}`;
  // Already has an extension — trust the caller's filename.
  if (/\.[a-z0-9]{1,8}$/i.test(trimmed)) return trimmed;
  return `${trimmed}.${ext}`;
}

/* ── Capability detection ─────────────────────────────────────────────── */

/**
 * True when the host can share files / urls: the web Share API is present, OR
 * a Capacitor Share plugin is available on the global bridge.
 */
export function canShareFiles(): boolean {
  if (getCapacitorShare()) return true;
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    share?: unknown;
    canShare?: unknown;
  };
  return typeof nav.share === "function" || typeof nav.canShare === "function";
}

/* ── Internal helpers ─────────────────────────────────────────────────── */

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === "TimeoutError") return false;
  return (
    name === "AbortError" ||
    (typeof message === "string" && /abort|cancel/i.test(message))
  );
}

const DOWNLOAD_SHARE_FETCH_TIMEOUT_MS = 15_000;

async function fetchDownloadBlob(
  url: string,
  callerSignal?: AbortSignal,
): Promise<Blob> {
  callerSignal?.throwIfAborted();

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException("Attachment download timed out", "TimeoutError"),
    );
  }, DOWNLOAD_SHARE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Download request failed (${response.status})`);
    }
    return await response.blob();
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

/** Web/desktop fallback: object-URL + temporary `<a download>` click. */
async function downloadViaAnchor(
  url: string,
  filename: string,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof document === "undefined") {
    throw new Error("downloadAttachment: no document available");
  }

  let objectUrl: string | null = null;
  let href = url;
  try {
    // Same-origin / fetchable assets: pull to a blob so the download attribute
    // is honored cross-origin and so blob:/data: sources work uniformly.
    if (typeof fetch === "function" && !url.startsWith("data:")) {
      const blob = await fetchDownloadBlob(url, signal);
      if (typeof URL !== "undefined" && URL.createObjectURL) {
        objectUrl = URL.createObjectURL(blob);
        href = objectUrl;
      }
    }
  } catch {
    signal?.throwIfAborted();
    // error-policy:J4 network/CORS failure on the blob prefetch — degrade to
    // linking the raw url directly; the browser surfaces its own failure.
    href = url;
  }

  signal?.throwIfAborted();

  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  if (objectUrl && typeof URL !== "undefined" && URL.revokeObjectURL) {
    // Revoke after the click has been dispatched.
    URL.revokeObjectURL(objectUrl);
  }
}

/** Encode an ArrayBuffer to base64 without external deps. SSR-safe. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  if (typeof btoa === "function") return btoa(binary);
  // Node/SSR fallback.
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  throw new Error("base64 encoding unavailable");
}

/**
 * Native path: write the bytes into the Capacitor Cache directory via the
 * global Filesystem plugin, then best-effort Share/open the resulting file.
 * Returns true on success; false to signal the caller should fall back.
 */
async function downloadViaCapacitor(
  url: string,
  filename: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const fs = getCapacitorFilesystem();
  if (!fs || typeof fetch !== "function") return false;
  try {
    const data = arrayBufferToBase64(
      await (await fetchDownloadBlob(url, signal)).arrayBuffer(),
    );
    signal?.throwIfAborted();
    const written = await fs.writeFile({
      path: filename,
      data,
      directory: "CACHE",
    });
    // Best-effort: surface the saved file via the Share sheet so the user can
    // route it to Files / Photos / another app. Failure here is non-fatal —
    // the file is already written to the cache.
    const share = getCapacitorShare();
    const fileUri =
      written?.uri ??
      (typeof fs.getUri === "function"
        ? (await fs.getUri({ path: filename, directory: "CACHE" }))?.uri
        : undefined);
    if (share && fileUri) {
      try {
        await share.share({ url: fileUri, title: filename, files: [fileUri] });
      } catch {
        // error-policy:J4 user cancelled or share sheet unavailable — the
        // file is already saved to the cache; nothing was lost.
      }
    }
    return true;
  } catch {
    signal?.throwIfAborted();
    // error-policy:J4 `false` signals the caller to fall back to the web
    // download path — the documented chain contract of this helper.
    return false;
  }
}

/* ── Public API ───────────────────────────────────────────────────────── */

/**
 * Download an attachment to the device.
 *
 * Native (Capacitor): write to the Cache directory and best-effort share/open.
 * Web/desktop: try `showSaveFilePicker`, else fetch → blob → `<a download>`.
 *
 * Never throws for the common case — failures degrade to the web `<a download>`
 * fallback. An explicit caller abort stops the fallback chain and preserves the
 * caller's abort reason.
 */
export async function downloadAttachment(
  url: string,
  filename: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  // Native path first when we're truly on a native platform with a bridge.
  if (isNativePlatform() && getCapacitorFilesystem()) {
    const ok = await downloadViaCapacitor(url, filename, signal);
    if (ok) return;
    // fall through to the web path on any native failure.
  }

  // File System Access API (Chromium desktop/web) — lets the user choose where.
  const picker =
    typeof window !== "undefined" ? window.showSaveFilePicker : undefined;
  if (
    typeof picker === "function" &&
    typeof fetch === "function" &&
    !url.startsWith("data:")
  ) {
    let pickerOpened = false;
    try {
      const blob = await fetchDownloadBlob(url, signal);
      signal?.throwIfAborted();
      pickerOpened = true;
      const handle = await picker({ suggestedName: filename });
      signal?.throwIfAborted();
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      signal?.throwIfAborted();
      // error-policy:J4 user cancelled the picker → done (don't
      // double-download); any other failure falls through to the anchor path.
      if (pickerOpened && isAbortError(err)) return;
    }
  }

  await downloadViaAnchor(url, filename, signal);
}

/**
 * Share an attachment via the platform share sheet.
 *
 * Native: `Capacitor.Plugins.Share.share({ url, title })`.
 * Web: `navigator.share({ url, title })` when available.
 *
 * Returns `false` (so the caller can fall back to a download) when no share
 * path exists or the user cancels. User cancellation (AbortError) is swallowed.
 */
export async function shareAttachment(
  url: string,
  opts?: { title?: string; filename?: string },
): Promise<boolean> {
  const title = opts?.title;

  const capShare = getCapacitorShare();
  if (capShare) {
    try {
      await capShare.share({ url, title });
      return true;
    } catch (err) {
      // error-policy:J4 cancel reads as "not shared"; other failures fall
      // through to the web share path (documented chain contract).
      if (isAbortError(err)) return false;
    }
  }

  if (typeof navigator !== "undefined") {
    const nav = navigator as Navigator & {
      share?: (data: { url?: string; title?: string }) => Promise<void>;
    };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ url, title });
        return true;
      } catch (err) {
        // error-policy:J4 `false` signals the caller to fall back to a plain
        // download (documented contract); cancel and failure both read as
        // "not shared".
        if (isAbortError(err)) return false;
        return false;
      }
    }
  }

  return false;
}
