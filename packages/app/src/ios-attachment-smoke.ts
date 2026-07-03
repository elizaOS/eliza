const IOS_ATTACHMENT_SMOKE_REQUEST_KEY = "eliza:ios-attachment-smoke:request";
const IOS_ATTACHMENT_SMOKE_RESULT_KEY = "eliza:ios-attachment-smoke:result";
const IOS_ATTACHMENT_SMOKE_TIMEOUT_MS = 180_000;
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
    apiBase: "http://127.0.0.1:31337",
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
  const cap = (globalThis as { Capacitor?: unknown }).Capacitor;
  if (!cap || typeof cap !== "object") return undefined;
  const plugins = (cap as { Plugins?: Record<string, unknown> }).Plugins;
  const fs = plugins?.Filesystem;
  if (!fs || typeof fs !== "object") return undefined;
  return typeof (fs as CapacitorFilesystemSmokeLike).writeFile === "function"
    ? (fs as CapacitorFilesystemSmokeLike)
    : undefined;
}

function readCapacitorShareForSmoke(): CapacitorShareSmokeLike | undefined {
  const cap = (globalThis as { Capacitor?: unknown }).Capacitor;
  if (!cap || typeof cap !== "object") return undefined;
  const plugins = (cap as { Plugins?: Record<string, unknown> }).Plugins;
  const share = plugins?.Share;
  if (!share || typeof share !== "object") return undefined;
  return typeof (share as CapacitorShareSmokeLike).share === "function"
    ? (share as CapacitorShareSmokeLike)
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
    // Relative API paths inside a Capacitor WKWebView resolve to the app origin,
    // so use the same configured agent base as the rest of the UI client.
  }
  const base = (getApiBaseUrl() || fallbackBase).replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

async function writeAttachmentResult(
  writeResult: RunIosAttachmentSmokeOptions["writeResult"],
  result: Record<string, unknown>,
): Promise<void> {
  await writeResult(IOS_ATTACHMENT_SMOKE_RESULT_KEY, result);
}

export async function runIosAttachmentSmokeIfRequested({
  isIOS,
  getApiBaseUrl,
  getPreference,
  removePreference,
  writeResult,
  waitForElement,
  readStorageSnapshot,
}: RunIosAttachmentSmokeOptions): Promise<boolean> {
  if (!isIOS || iosAttachmentSmokeStarted) return iosAttachmentSmokeStarted;
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(IOS_ATTACHMENT_SMOKE_REQUEST_KEY);
  } catch {
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
    await waitForElement<HTMLElement>(
      '[data-testid="home-launcher-surface"][data-page="home"]',
      { visible: true, timeoutMs: IOS_ATTACHMENT_SMOKE_TIMEOUT_MS },
    );

    const sourceBytes = bytesFromBase64(request.dataUrl.split(",")[1] ?? "");
    const expectedSha256 = await sha256Hex(sourceBytes);
    const uploadUrl = resolveIosAttachmentSmokeApiUrl(
      "/api/background/upload-image",
      request.apiBase,
      getApiBaseUrl,
    );
    const upload = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ dataUrl: request.dataUrl }),
    });
    const uploadText = await upload.text();
    if (!upload.ok) {
      throw new Error(
        `/api/background/upload-image returned HTTP ${upload.status}: ${uploadText.slice(0, 500)}`,
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
    const mediaResponse = await fetch(mediaFetchUrl);
    if (!mediaResponse.ok) {
      throw new Error(
        `media fetch returned HTTP ${mediaResponse.status} for ${mediaFetchUrl}`,
      );
    }
    const servedBytes = new Uint8Array(await mediaResponse.arrayBuffer());
    const servedSha256 = await sha256Hex(servedBytes);
    if (servedSha256 !== expectedSha256) {
      throw new Error(
        `served sha256 mismatch: expected ${expectedSha256}, got ${servedSha256}`,
      );
    }

    const filesystem = readCapacitorFilesystemForSmoke();
    const share = readCapacitorShareForSmoke();
    if (!filesystem) {
      throw new Error("Capacitor Filesystem plugin is unavailable");
    }
    if (!share) {
      throw new Error("Capacitor Share plugin is unavailable");
    }

    const written = await filesystem.writeFile({
      path: request.filename,
      data: base64FromBytes(servedBytes),
      directory: "CACHE",
    });
    const readBack = filesystem.readFile
      ? await filesystem.readFile({
          path: request.filename,
          directory: "CACHE",
        })
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
            await filesystem.getUri({
              path: request.filename,
              directory: "CACHE",
            })
          )?.uri
        : undefined);
    if (!uri) {
      throw new Error("Filesystem did not return a file URI");
    }

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
    await writeAttachmentResult(writeResult, {
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      error: error instanceof Error ? error.message : String(error),
      storage: readStorageSnapshot(),
      plugins: {
        filesystem: Boolean(readCapacitorFilesystemForSmoke()),
        share: Boolean(readCapacitorShareForSmoke()),
      },
    });
  } finally {
    try {
      window.localStorage.removeItem(IOS_ATTACHMENT_SMOKE_REQUEST_KEY);
    } catch {
      // Preferences removal below is authoritative for the simulator harness.
    }
    await removePreference(IOS_ATTACHMENT_SMOKE_REQUEST_KEY);
  }
  return true;
}
