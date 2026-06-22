/**
 * download-share.ts — transport-capability-aware download + share helper.
 *
 * Client-only utility (no server logger here). Designed to work across:
 *  - pure browser tabs (web Share API / `<a download>` / showSaveFilePicker),
 *  - desktop shells (same web paths),
 *  - Capacitor (iOS/Android) shells via the GLOBAL bridge at
 *    `globalThis.Capacitor.Plugins.*` — never an `import('@capacitor/...')`,
 *    because that dependency is intentionally NOT installed yet.
 *
 * Everything is SSR-safe: all `window` / `navigator` / `globalThis.Capacitor`
 * access is guarded with `typeof` checks and never assumes the bridge exists.
 */

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
  return (
    err instanceof Error &&
    (err.name === "AbortError" || /abort|cancel/i.test(err.message))
  );
}

/** Web/desktop fallback: object-URL + temporary `<a download>` click. */
async function downloadViaAnchor(url: string, filename: string): Promise<void> {
  if (typeof document === "undefined") {
    throw new Error("downloadAttachment: no document available");
  }

  let objectUrl: string | null = null;
  let href = url;
  try {
    // Same-origin / fetchable assets: pull to a blob so the download attribute
    // is honored cross-origin and so blob:/data: sources work uniformly.
    if (typeof fetch === "function" && !url.startsWith("data:")) {
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        if (typeof URL !== "undefined" && URL.createObjectURL) {
          objectUrl = URL.createObjectURL(blob);
          href = objectUrl;
        }
      }
    }
  } catch {
    // Network/CORS failure — fall back to linking the raw url directly.
    href = url;
  }

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
): Promise<boolean> {
  const fs = getCapacitorFilesystem();
  if (!fs || typeof fetch !== "function") return false;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const data = arrayBufferToBase64(await res.arrayBuffer());
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
        // user cancelled or share unavailable — file is still saved.
      }
    }
    return true;
  } catch {
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
 * fallback. The final fallback may surface an error to the caller's catch.
 */
export async function downloadAttachment(
  url: string,
  filename: string,
): Promise<void> {
  // Native path first when we're truly on a native platform with a bridge.
  if (isNativePlatform() && getCapacitorFilesystem()) {
    const ok = await downloadViaCapacitor(url, filename);
    if (ok) return;
    // fall through to the web path on any native failure.
  }

  // File System Access API (Chromium desktop/web) — lets the user choose where.
  if (
    typeof window !== "undefined" &&
    typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker ===
      "function" &&
    typeof fetch === "function" &&
    !url.startsWith("data:")
  ) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        const picker = (
          window as unknown as {
            showSaveFilePicker: (opts: { suggestedName?: string }) => Promise<{
              createWritable: () => Promise<{
                write: (data: Blob) => Promise<void>;
                close: () => Promise<void>;
              }>;
            }>;
          }
        ).showSaveFilePicker;
        const handle = await picker({ suggestedName: filename });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      }
    } catch (err) {
      // User cancelled the picker — do nothing further (don't double-download).
      if (isAbortError(err)) return;
      // Otherwise fall through to the anchor fallback.
    }
  }

  await downloadViaAnchor(url, filename);
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
      if (isAbortError(err)) return false;
      // fall through to the web path.
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
        if (isAbortError(err)) return false;
        return false;
      }
    }
  }

  return false;
}
