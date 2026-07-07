/**
 * On-device iOS attachment round-trip smoke, run inside the shipped app (not a
 * unit test) when the CI/QA harness stages a request in localStorage/Preferences
 * (`eliza:ios-attachment-smoke:request`). `runIosAttachmentSmokeIfRequested()`
 * waits for any pending onboarding smoke, uploads a 1×1 PNG to
 * `/api/device-e2e/upload-image`, asserts the returned content-addressed
 * `/api/media/<sha256>.png` URL and the re-fetched served bytes match the source
 * sha256, writes those bytes through the Capacitor Filesystem CACHE directory
 * and reads them back (sha256 re-verified), then opens the native Share sheet
 * with the file URI. Every phase and the final ok/failed verdict are persisted
 * to Preferences (`…:result`) for the simulator harness to poll; runs at most
 * once per app launch.
 */
import { Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { shellLocalStorage } from "@elizaos/ui/bridge";

const IOS_ATTACHMENT_SMOKE_REQUEST_KEY = "eliza:ios-attachment-smoke:request";
const IOS_ATTACHMENT_SMOKE_RESULT_KEY = "eliza:ios-attachment-smoke:result";
const IOS_ONBOARDING_SMOKE_RESULT_KEY = "eliza:ios-onboarding-smoke:result";
const IOS_ATTACHMENT_SMOKE_TIMEOUT_MS = 180_000;
const IOS_ATTACHMENT_OPERATION_TIMEOUT_MS = 15_000;
const IOS_ATTACHMENT_SMOKE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

interface IosAttachmentSmokeRequest {
  apiBase: string;
  filename: string;
  dataUrl: string;
}

interface CapacitorFilesystemSmokeLike {
  writeFile(options: {
    path: string;
    data: string;
    directory?: string;
  }): Promise<{ uri?: string }>;
  readFile?(options: {
    path: string;
    directory?: string;
  }): Promise<{ data?: string | Blob }>;
  getUri?(options: {
    path: string;
    directory?: string;
  }): Promise<{ uri?: string }>;
}

interface CapacitorShareSmokeLike {
  share(options: {
    url?: string;
    title?: string;
    text?: string;
    files?: string[];
  }): Promise<unknown>;
}

interface RunIosAttachmentSmokeOptions {
  isIOS: boolean;
  getApiBaseUrl: () => string;
  getPreference: (key: string) => Promise<string | null>;
  removePreference: (key: string) => Promise<void>;
  writeResult: (key: string, result: Record<string, unknown>) => Promise<void>;
  waitForElement: <T extends Element>(
    selector: string,
    options?: { timeoutMs?: number; visible?: boolean },
  ) => Promise<T>;
  readStorageSnapshot: () => Record<string, string | null>;
}

let iosAttachmentSmokeStarted = false;

function parseIosAttachmentSmokeRequest(
  raw: string | null,
): IosAttachmentSmokeRequest {
  const fallback = {
    apiBase: "http://127.0.0.1:31338",
    filename: "eliza-ios-attachment-smoke.png",
    dataUrl: `data:image/png;base64,${IOS_ATTACHMENT_SMOKE_PNG_BASE64}`,
  };
  if (!raw || raw === "1") return fallback;
  try {
    const parsed = JSON.parse(raw) as {
      apiBase?: unknown;
      filename?: unknown;
      dataUrl?: unknown;
    };
    return {
      apiBase:
        typeof parsed.apiBase === "string" && parsed.apiBase.trim()
          ? parsed.apiBase.trim()
          : fallback.apiBase,
      filename:
        typeof parsed.filename === "string" && parsed.filename.trim()
          ? parsed.filename.trim()
          : fallback.filename,
      dataUrl:
        typeof parsed.dataUrl === "string" &&
        parsed.dataUrl.startsWith("data:image/")
          ? parsed.dataUrl
          : fallback.dataUrl,
    };
  } catch {
    // error-policy:J3 corrupt smoke-request blob — run with the defaults
    return fallback;
  }
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function bytesFromFilesystemReadData(
  data: string | Blob | undefined,
): Promise<Uint8Array> {
  if (typeof data === "string") return bytesFromBase64(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new Error("Filesystem.readFile returned no data");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copy.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readCapacitorFilesystemForSmoke():
  | CapacitorFilesystemSmokeLike
  | undefined {
  return typeof Filesystem?.writeFile === "function"
    ? (Filesystem as CapacitorFilesystemSmokeLike)
    : undefined;
}

function readCapacitorShareForSmoke(): CapacitorShareSmokeLike | undefined {
  return typeof Share?.share === "function"
    ? (Share as CapacitorShareSmokeLike)
    : undefined;
}

function resolveIosAttachmentSmokeApiUrl(
  path: string,
  fallbackBase: string,
  getApiBaseUrl: () => string,
): string {
  try {
    return new URL(path).toString();
  } catch {
    // error-policy:J3 not an absolute URL — relative API paths inside a
    // Capacitor WKWebView resolve to the app origin, so use the same
    // configured agent base as the rest of the UI client
  }
  const base = (fallbackBase.trim() || getApiBaseUrl()).replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

async function writeAttachmentResult(
  writeResult: RunIosAttachmentSmokeOptions["writeResult"],
  result: Record<string, unknown>,
): Promise<void> {
  await writeResult(IOS_ATTACHMENT_SMOKE_RESULT_KEY, result);
}

async function writeAttachmentPhase(
  writeResult: RunIosAttachmentSmokeOptions["writeResult"],
  request: IosAttachmentSmokeRequest,
  phase: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeAttachmentResult(writeResult, {
    ok: false,
    phase,
    updatedAt: new Date().toISOString(),
    apiBase: request.apiBase,
    ...extra,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function withTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs = IOS_ATTACHMENT_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: number | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
}

async function readSmokePreference(
  key: string,
  getPreference: RunIosAttachmentSmokeOptions["getPreference"],
): Promise<string | null> {
  const preferenceValue = await getPreference(key);
  if (preferenceValue) return preferenceValue;
  try {
    const value = window.localStorage.getItem(key);
    if (value) return value;
  } catch {
    // error-policy:J4 unavailable localStorage — Preferences (already read
    // above) is the authoritative native store for the simulator harness
  }
  return null;
}

async function waitForOnboardingSmokeResultIfPresent(
  getPreference: RunIosAttachmentSmokeOptions["getPreference"],
): Promise<void> {
  const initial = await readSmokePreference(
    IOS_ONBOARDING_SMOKE_RESULT_KEY,
    getPreference,
  );
  if (!initial) {
    await sleep(750);
    return;
  }

  const deadline = Date.now() + IOS_ATTACHMENT_SMOKE_TIMEOUT_MS;
  let lastRaw = initial;
  while (Date.now() < deadline) {
    const raw =
      (await readSmokePreference(
        IOS_ONBOARDING_SMOKE_RESULT_KEY,
        getPreference,
      )) ?? lastRaw;
    lastRaw = raw;
    try {
      const parsed = JSON.parse(raw) as {
        ok?: unknown;
        phase?: unknown;
        error?: unknown;
      };
      if (parsed.ok === true || parsed.phase === "complete") return;
      if (parsed.phase === "failed" || parsed.error) {
        throw new Error(
          `iOS onboarding smoke failed before attachment: ${raw}`,
        );
      }
    } catch (error) {
      // error-policy:J3 corrupt interim result blob — keep polling; a parsed
      // "failed" result still propagates
      if (error instanceof Error && error.message.includes("failed")) {
        throw error;
      }
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for iOS onboarding smoke before attachment. Last result: ${lastRaw}`,
  );
}

export async function runIosAttachmentSmokeIfRequested({
  isIOS,
  getApiBaseUrl,
  getPreference,
  removePreference,
  writeResult,
  readStorageSnapshot,
}: RunIosAttachmentSmokeOptions): Promise<boolean> {
  if (!isIOS || iosAttachmentSmokeStarted) return iosAttachmentSmokeStarted;
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(IOS_ATTACHMENT_SMOKE_REQUEST_KEY);
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences read below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await getPreference(IOS_ATTACHMENT_SMOKE_REQUEST_KEY);
  }
  if (!rawRequest) return false;

  iosAttachmentSmokeStarted = true;
  const request = parseIosAttachmentSmokeRequest(rawRequest);
  await writeAttachmentResult(writeResult, {
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
    apiBase: request.apiBase,
  });

  try {
    await waitForOnboardingSmokeResultIfPresent(getPreference);

    const sourceBytes = bytesFromBase64(request.dataUrl.split(",")[1] ?? "");
    const expectedSha256 = await sha256Hex(sourceBytes);
    const uploadUrl = resolveIosAttachmentSmokeApiUrl(
      "/api/device-e2e/upload-image",
      request.apiBase,
      getApiBaseUrl,
    );
    await writeAttachmentPhase(writeResult, request, "uploading-media", {
      uploadUrl,
    });
    const upload = await withTimeout(
      "image upload fetch",
      fetch(uploadUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ dataUrl: request.dataUrl }),
      }),
    );
    const uploadText = await withTimeout(
      "image upload response body",
      upload.text(),
      5_000,
    );
    if (!upload.ok) {
      throw new Error(
        `/api/device-e2e/upload-image returned HTTP ${upload.status}: ${uploadText.slice(0, 500)}`,
      );
    }
    const uploadJson = JSON.parse(uploadText) as { url?: unknown };
    const mediaUrl = typeof uploadJson.url === "string" ? uploadJson.url : "";
    if (!/^\/api\/media\/[a-f0-9]{64}\.png$/.test(mediaUrl)) {
      throw new Error(`Upload returned non media-store URL: ${mediaUrl}`);
    }
    if (!mediaUrl.includes(expectedSha256)) {
      throw new Error(
        `Media URL hash mismatch: expected ${expectedSha256}, got ${mediaUrl}`,
      );
    }

    const mediaFetchUrl = resolveIosAttachmentSmokeApiUrl(
      mediaUrl,
      request.apiBase,
      getApiBaseUrl,
    );
    await writeAttachmentPhase(writeResult, request, "fetching-media", {
      mediaUrl,
      mediaFetchUrl,
    });
    const mediaResponse = await withTimeout(
      "media fetch",
      fetch(mediaFetchUrl),
    );
    if (!mediaResponse.ok) {
      throw new Error(
        `media fetch returned HTTP ${mediaResponse.status} for ${mediaFetchUrl}`,
      );
    }
    const servedBytes = new Uint8Array(
      await withTimeout("media response body", mediaResponse.arrayBuffer()),
    );
    const servedSha256 = await sha256Hex(servedBytes);
    if (servedSha256 !== expectedSha256) {
      throw new Error(
        `served sha256 mismatch: expected ${expectedSha256}, got ${servedSha256}`,
      );
    }

    await writeAttachmentPhase(writeResult, request, "loading-native-plugins");
    const filesystem = readCapacitorFilesystemForSmoke();
    const share = readCapacitorShareForSmoke();
    if (!filesystem) {
      throw new Error("Capacitor Filesystem plugin is unavailable");
    }
    if (!share) {
      throw new Error("Capacitor Share plugin is unavailable");
    }

    await writeAttachmentPhase(writeResult, request, "writing-filesystem");
    const written = await withTimeout(
      "Filesystem.writeFile",
      filesystem.writeFile({
        path: request.filename,
        data: base64FromBytes(servedBytes),
        directory: "CACHE",
      }),
    );
    await writeAttachmentPhase(writeResult, request, "reading-filesystem");
    const readBack = filesystem.readFile
      ? await withTimeout(
          "Filesystem.readFile",
          filesystem.readFile({
            path: request.filename,
            directory: "CACHE",
          }),
        )
      : undefined;
    const readBackBytes = await bytesFromFilesystemReadData(readBack?.data);
    const readBackSha256 = await sha256Hex(readBackBytes);
    if (readBackSha256 !== expectedSha256) {
      throw new Error(
        `Filesystem read-back sha256 mismatch: expected ${expectedSha256}, got ${readBackSha256}`,
      );
    }

    const uri =
      written?.uri ??
      (filesystem.getUri
        ? (
            await withTimeout(
              "Filesystem.getUri",
              filesystem.getUri({
                path: request.filename,
                directory: "CACHE",
              }),
            )
          )?.uri
        : undefined);
    if (!uri) {
      throw new Error("Filesystem did not return a file URI");
    }

    await writeAttachmentPhase(writeResult, request, "sharing-file", {
      fileUri: uri,
    });
    let shareOutcome: Record<string, unknown> = { attempted: true };
    try {
      await Promise.race([
        share.share({
          url: uri,
          title: request.filename,
          files: [uri],
        }),
        new Promise<"timeout">((resolve) =>
          window.setTimeout(() => resolve("timeout"), 8_000),
        ),
      ]).then((result) => {
        shareOutcome =
          result === "timeout"
            ? { attempted: true, timedOutWithSheetLikelyOpen: true }
            : { attempted: true, settled: true };
      });
    } catch (error) {
      // error-policy:J1 the share failure is recorded in the smoke result
      shareOutcome = {
        attempted: true,
        rejected: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    await writeAttachmentResult(writeResult, {
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      mediaUrl,
      mediaFetchUrl,
      expectedSha256,
      servedSha256,
      readBackSha256,
      byteLength: servedBytes.byteLength,
      fileUri: uri,
      plugins: {
        filesystem: true,
        filesystemReadFile: typeof filesystem.readFile === "function",
        share: true,
      },
      share: shareOutcome,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    const filesystem = readCapacitorFilesystemForSmoke();
    const share = readCapacitorShareForSmoke();
    await writeAttachmentResult(writeResult, {
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      error: error instanceof Error ? error.message : String(error),
      storage: readStorageSnapshot(),
      plugins: {
        filesystem: Boolean(filesystem),
        share: Boolean(share),
      },
    });
  } finally {
    try {
      shellLocalStorage.removeItem(IOS_ATTACHMENT_SMOKE_REQUEST_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
    }
    await removePreference(IOS_ATTACHMENT_SMOKE_REQUEST_KEY);
  }
  return true;
}
