import {
  CONTENT_PACK_MANIFEST_FILENAME,
  type ContentPackColorScheme,
  type ContentPackManifest,
  type ContentPackSource,
  type ResolvedContentPack,
  validateContentPackManifest,
} from "@elizaos/contracts";
import { applyThemeToDocument } from "./theme";

/** Manifest reads are short UI requests and must not stall pack loading. */
export const CONTENT_PACK_MANIFEST_FETCH_TIMEOUT_MS = 15000;
/** A manifest is metadata, so bound it independently of its asset payloads. */
export const CONTENT_PACK_MANIFEST_MAX_BYTES = 1024 * 1024;
/** Teardown must not turn an untrusted stream's cancel hook into a new stall. */
const CONTENT_PACK_READER_CANCEL_TIMEOUT_MS = 250;
class ContentPackManifestTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Content pack manifest exceeds ${maxBytes} bytes`);
    this.name = "ContentPackManifestTooLargeError";
  }
}
function cancelManifestBody(
  body: Pick<ReadableStream<Uint8Array>, "cancel"> | undefined | null,
  reason: unknown,
): void {
  if (!body) return;
  // error-policy:J5 allSettled observes a best-effort cancellation rejection;
  // the original transport/validation failure remains the caller-visible one.
  void Promise.allSettled([body.cancel(reason)]);
}
async function cancelManifestReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, CONTENT_PACK_READER_CANCEL_TIMEOUT_MS);
  });
  // error-policy:J5 allSettled observes a hostile or failed cancel hook; the
  // bounded race ensures teardown cannot replace the original body failure.
  await Promise.race([
    Promise.allSettled([reader.cancel(reason)]).then(() => undefined),
    timeout,
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
}
async function readBoundedManifestJson<T>(
  response: Response,
  signal: AbortSignal,
  sizeAbort: AbortController,
  maxBytes: number,
): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(
      "Content pack manifest byte limit must be a positive safe integer",
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      const error = new ContentPackManifestTooLargeError(maxBytes);
      cancelManifestBody(response.body, error);
      sizeAbort.abort(error);
      throw error;
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Content pack manifest response has no body");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let receivedBytes = 0;
  let json = "";
  let bodyComplete = false;
  let bodyFailed = false;
  let rejectOnAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort?.(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        bodyComplete = true;
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        const error = new ContentPackManifestTooLargeError(maxBytes);
        sizeAbort.abort(error);
        throw error;
      }
      json += decoder.decode(value, { stream: true });
    }
    json += decoder.decode();
    return JSON.parse(json) as T;
  } catch (error) {
    bodyFailed = true;
    if (!bodyComplete) await cancelManifestReader(reader, error);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!bodyFailed) {
      reader.releaseLock();
    } else {
      // error-policy:J5 a timed-out cancel can leave a read pending, so observe
      // releaseLock rejection without masking the original caller-visible error.
      await Promise.allSettled([
        Promise.resolve().then(() => reader.releaseLock()),
      ]);
    }
  }
}
/** Fetch and fully consume one manifest within a single request/body deadline. */
export async function getContentPackManifestJsonWithFetch<T>(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number = CONTENT_PACK_MANIFEST_FETCH_TIMEOUT_MS,
  maxBytes: number = CONTENT_PACK_MANIFEST_MAX_BYTES,
  callerSignal?: AbortSignal,
): Promise<T> {
  const sizeAbort = new AbortController();
  const signals = [AbortSignal.timeout(timeoutMs), sizeAbort.signal];
  if (callerSignal) signals.push(callerSignal);
  const signal = AbortSignal.any(signals);
  const response = await fetchImpl(url, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${response.statusText}`);
    cancelManifestBody(response.body, error);
    throw error;
  }
  return await readBoundedManifestJson<T>(
    response,
    signal,
    sizeAbort,
    maxBytes,
  );
}
export class ContentPackLoadError extends Error {
  constructor(
    message: string,
    public readonly source: ContentPackSource,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ContentPackLoadError";
  }
}
const filePackObjectUrls = new WeakMap<ResolvedContentPack, string[]>();
/**
 * Load a content pack from a base URL (directory containing pack.json).
 * The base URL should end with a trailing slash.
 */
export async function loadContentPackFromUrl(
  baseUrl: string,
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<ResolvedContentPack> {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const source: ContentPackSource = { kind: "url", url: normalizedBase };
  const manifestUrl = `${normalizedBase}${CONTENT_PACK_MANIFEST_FILENAME}`;
  let raw: unknown;
  try {
    raw = await getContentPackManifestJsonWithFetch(
      manifestUrl,
      globalThis.fetch,
      CONTENT_PACK_MANIFEST_FETCH_TIMEOUT_MS,
      CONTENT_PACK_MANIFEST_MAX_BYTES,
      options.signal,
    );
  } catch (err) {
    // error-policy:J2 retain the source URL while preserving the transport,
    // body-read, timeout, or caller-cancellation failure as the cause.
    throw new ContentPackLoadError(
      err instanceof ContentPackManifestTooLargeError
        ? err.message
        : `Failed to fetch pack manifest from ${manifestUrl}`,
      source,
      err,
    );
  }
  const errors = validateContentPackManifest(raw);
  if (errors.length > 0) {
    throw new ContentPackLoadError(
      `Invalid pack manifest: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
      source,
    );
  }
  const manifest = raw as ContentPackManifest;
  return resolvePackAssets(manifest, normalizedBase, source);
}
/**
 * Load a content pack from an array of local browser File objects (e.g. from an <input webkitdirectory />).
 */
export async function loadContentPackFromFiles(
  files: File[],
): Promise<ResolvedContentPack> {
  const packFile = files.find(
    (file) =>
      file.webkitRelativePath.endsWith(CONTENT_PACK_MANIFEST_FILENAME) ||
      file.name === CONTENT_PACK_MANIFEST_FILENAME,
  );
  if (!packFile) {
    throw new ContentPackLoadError(
      "Could not find pack.json in the selected folder.",
      { kind: "file", path: "local-folder" },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await packFile.text());
  } catch (err) {
    throw new ContentPackLoadError(
      "Failed to parse pack.json",
      { kind: "file", path: "local-folder" },
      err,
    );
  }
  const errors = validateContentPackManifest(raw);
  if (errors.length > 0) {
    throw new ContentPackLoadError(
      `Invalid pack manifest: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
      { kind: "file", path: "local-folder" },
    );
  }
  const manifest = raw as ContentPackManifest;
  const { assets } = manifest;
  const objectUrls: string[] = [];
  const packRootPath = packFile.webkitRelativePath.replace(
    /\/?pack\.json$/,
    "",
  );
  const packRootSegments = packRootPath ? packRootPath.split("/") : [];
  const resolveBlobUrl = (path: string | undefined): string | undefined => {
    if (!path) return undefined;
    const normalizedPath = path.replace(/^\.\/|^\//, "");
    const targetSegments = [...packRootSegments, ...normalizedPath.split("/")];
    const fileMatch = files.find((file) => {
      const relativeSegments = file.webkitRelativePath
        ? file.webkitRelativePath.split("/")
        : [file.name];
      if (relativeSegments.length !== targetSegments.length) return false;
      return targetSegments.every(
        (segment, index) => segment === relativeSegments[index],
      );
    });
    if (!fileMatch) return undefined;
    const objectUrl = URL.createObjectURL(fileMatch);
    objectUrls.push(objectUrl);
    return objectUrl;
  };
  const folderPath =
    packFile.webkitRelativePath
      .replace(CONTENT_PACK_MANIFEST_FILENAME, "")
      .replace(/\/$/, "") || "local-folder";
  const pack: ResolvedContentPack = {
    manifest,
    vrmUrl: resolveBlobUrl(assets.vrm?.file),
    vrmPreviewUrl: resolveBlobUrl(assets.vrm?.preview),
    backgroundUrl: resolveBlobUrl(assets.background),
    worldUrl: resolveBlobUrl(assets.world),
    colorScheme: assets.colorScheme,
    // streamOverlayPath isn't translatable directly to a Blob URL without a full virtual fs
    personality: assets.personality,
    source: { kind: "file", path: folderPath },
  };
  if (objectUrls.length > 0) {
    filePackObjectUrls.set(pack, objectUrls);
  }
  return pack;
}
export function releaseLoadedContentPack(pack: ResolvedContentPack): void {
  const objectUrls = filePackObjectUrls.get(pack);
  if (!objectUrls) return;
  for (const objectUrl of objectUrls) {
    URL.revokeObjectURL(objectUrl);
  }
  filePackObjectUrls.delete(pack);
}
/**
 * Resolve a pack from an already-parsed manifest and a base URL.
 * Useful for bundled packs that ship with the app.
 */
export function resolveContentPackFromManifest(
  manifest: ContentPackManifest,
  baseUrl: string,
  source: ContentPackSource,
): ResolvedContentPack {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return resolvePackAssets(manifest, normalizedBase, source);
}
function resolvePackAssets(
  manifest: ContentPackManifest,
  baseUrl: string,
  source: ContentPackSource,
): ResolvedContentPack {
  const { assets } = manifest;
  const resolve = (path: string | undefined) =>
    path ? `${baseUrl}${path}` : undefined;
  return {
    manifest,
    vrmUrl: resolve(assets.vrm?.file),
    vrmPreviewUrl: resolve(assets.vrm?.preview),
    backgroundUrl: resolve(assets.background),
    worldUrl: resolve(assets.world),
    colorScheme: assets.colorScheme,
    streamOverlayPath: resolve(assets.streamOverlay),
    personality: assets.personality,
    source,
  };
}

/** Minimal state setters needed to apply a content pack. */
export interface ContentPackApplyDeps {
  setCustomVrmUrl: (url: string) => void;
  setCustomVrmPreviewUrl: (url: string) => void;
  setCustomBackgroundUrl: (url: string) => void;
  setCustomWorldUrl: (url: string) => void;
  setSelectedVrmIndex: (index: number) => void;
  setFirstRunName: (name: string) => void;
  setFirstRunStyle: (style: string) => void;
  setCustomCatchphrase: (phrase: string) => void;
  setCustomVoicePresetId: (id: string) => void;
}
/**
 * Apply a content pack to the app state.
 * Call this from first-run setup after the user selects a pack.
 */
export function applyContentPack(
  pack: ResolvedContentPack,
  deps: ContentPackApplyDeps,
): void {
  // VRM — bundled packs use avatarIndex, custom packs use vrmUrl
  if (pack.avatarIndex != null && pack.avatarIndex > 0) {
    deps.setSelectedVrmIndex(pack.avatarIndex);
    deps.setCustomVrmUrl("");
    deps.setCustomVrmPreviewUrl("");
  } else if (pack.vrmUrl) {
    deps.setCustomVrmUrl(pack.vrmUrl);
    deps.setCustomVrmPreviewUrl(pack.vrmPreviewUrl ?? "");
    deps.setSelectedVrmIndex(0); // 0 = custom VRM
  }
  // Background
  if (pack.backgroundUrl) {
    deps.setCustomBackgroundUrl(pack.backgroundUrl);
  }
  // Companion world scene
  deps.setCustomWorldUrl(pack.worldUrl ?? "");
  // Personality
  if (pack.personality?.name) {
    deps.setFirstRunName(pack.personality.name);
  }
  if (pack.personality?.catchphrase) {
    deps.setCustomCatchphrase(pack.personality.catchphrase);
  }
  if (pack.personality?.voicePresetId) {
    deps.setCustomVoicePresetId(pack.personality.voicePresetId);
  }
  if (pack.avatarIndex != null && pack.avatarIndex > 0 && pack.manifest.id) {
    deps.setFirstRunStyle(pack.manifest.id);
  }
}
// ── Color scheme CSS variable application ───────────────────────────
const COLOR_SCHEME_CSS_MAP: Record<
  keyof Omit<ContentPackColorScheme, "customProperties">,
  string
> = {
  accent: "--pack-accent",
  bg: "--pack-bg",
  card: "--pack-card",
  border: "--pack-border",
  text: "--pack-text",
  textMuted: "--pack-text-muted",
};
/**
 * Apply a content pack's color scheme as CSS custom properties on the
 * document root. Returns a cleanup function that removes them.
 *
 * If the pack includes a full ThemeDefinition (via `theme` field),
 * it takes precedence over the narrow colorScheme.
 */
export function applyColorScheme(
  scheme: ContentPackColorScheme | undefined,
  pack?: ResolvedContentPack,
): () => void {
  // Full theme takes precedence
  if (pack?.manifest.assets.theme) {
    const mode =
      typeof document !== "undefined" &&
      document.documentElement.getAttribute("data-theme") === "light"
        ? "light"
        : "dark";
    return applyThemeToDocument(pack.manifest.assets.theme, mode);
  }
  if (!scheme || typeof document === "undefined") return () => {};
  const root = document.documentElement;
  const applied: string[] = [];
  for (const [key, cssVar] of Object.entries(COLOR_SCHEME_CSS_MAP)) {
    const value = scheme[key as keyof typeof COLOR_SCHEME_CSS_MAP];
    if (value) {
      root.style.setProperty(cssVar, value);
      applied.push(cssVar);
    }
  }
  if (scheme.customProperties) {
    for (const [key, value] of Object.entries(scheme.customProperties)) {
      // Sanitize: reject values containing url() to prevent external
      // resource fetches when CSS vars are consumed by components.
      if (/url\s*\(/i.test(value)) continue;
      const cssVar = key.startsWith("--") ? key : `--${key}`;
      root.style.setProperty(cssVar, value);
      applied.push(cssVar);
    }
  }
  return () => {
    for (const cssVar of applied) {
      root.style.removeProperty(cssVar);
    }
  };
}
