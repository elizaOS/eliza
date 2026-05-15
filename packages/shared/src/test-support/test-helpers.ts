import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type http from "node:http";
import { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OPTIONAL_IMPORT_ERROR_MARKERS = [
  "Cannot find module",
  "Cannot find package",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "Dynamic require of",
  "native addon module",
  "Failed to resolve entry",
  "tfjs_binding",
  "NAPI_MODULE_NOT_FOUND",
  "spec not found",
];

/** Standardized test result for mocked updater checks. */
export type MockUpdateCheckResult = {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  channel: string;
  distTag: string;
  cached: boolean;
  error: string | null;
};

/** Snapshot and restore the configured environment variables around a test. */
export function createEnvSandbox(keys: readonly string[]) {
  const backup: Record<string, string | undefined> = {};

  function clear(): void {
    for (const key of keys) {
      backup[key] = process.env[key];
      delete process.env[key];
    }
  }

  function restore(): void {
    for (const key of keys) {
      if (backup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = backup[key];
      }
    }
  }

  return { clear, restore };
}

export type PluginModuleShape = {
  [key: string]: unknown;
  default?: unknown;
  plugin?: unknown;
};

/** Loose plugin-shape predicate used in dynamic test imports across suites. */
export function looksLikePlugin(value: unknown): value is { name: string } {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).name === "string"
  );
}

/** Extract a plugin-like object from a dynamic module export shape. */
export function extractPlugin(mod: PluginModuleShape): { name: string } | null {
  if (looksLikePlugin(mod.default)) return mod.default;
  if (looksLikePlugin(mod.plugin)) return mod.plugin;
  if (looksLikePlugin(mod)) return mod;
  for (const key of Object.keys(mod)) {
    if (key === "default" || key === "plugin") continue;
    if (looksLikePlugin(mod[key])) return mod[key] as { name: string };
  }
  return null;
}

export function isPackageImportResolvable(packageName: string): boolean {
  const require = createRequire(import.meta.url);
  try {
    require.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

export function isWorkspaceDependency(version: string | undefined): boolean {
  return (
    typeof version === "string" &&
    (version.startsWith(".") || version.startsWith("workspace:"))
  );
}

const DISCORD_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-discord";
const DISCORD_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-discord/dist/index",
] as const;

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function resolveFirstExistingPath(
  relativeEntryPaths: readonly string[],
): string | null {
  for (const relativeEntryPath of relativeEntryPaths) {
    const absoluteEntryPath = path.resolve(PACKAGE_ROOT, relativeEntryPath);
    if (existsSync(absoluteEntryPath)) {
      return pathToFileURL(absoluteEntryPath).href;
    }
  }

  return null;
}

function resolveNodeModulesEntry(
  packageName: string,
  relativeEntryPath: string,
): string | null {
  const packageSegments = packageName.split("/");
  const entryPath = path.resolve(
    PACKAGE_ROOT,
    "node_modules",
    ...packageSegments,
    relativeEntryPath,
  );
  return existsSync(entryPath) ? pathToFileURL(entryPath).href : null;
}

function resolvePluginImportSpecifier({
  packageName,
  alternatePackageNames = [],
  nodeModulesEntries = [],
  localEntries = [],
}: {
  packageName: string;
  alternatePackageNames?: readonly string[];
  nodeModulesEntries?: readonly {
    packageName: string;
    relativeEntryPath: string;
  }[];
  localEntries?: readonly string[];
}): string | null {
  for (const candidatePackageName of [packageName, ...alternatePackageNames]) {
    if (isPackageImportResolvable(candidatePackageName)) {
      return candidatePackageName;
    }
  }

  for (const entry of nodeModulesEntries) {
    const resolved = resolveNodeModulesEntry(
      entry.packageName,
      entry.relativeEntryPath,
    );
    if (resolved) return resolved;
  }

  return resolveFirstExistingPath(localEntries);
}

export function resolveDiscordPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: DISCORD_PLUGIN_PACKAGE_NAME,
    localEntries: DISCORD_PLUGIN_LOCAL_ENTRY_CANDIDATES,
  });
}

const TELEGRAM_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-telegram";
const TELEGRAM_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-telegram/dist/index",
] as const;

export function resolveTelegramPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: TELEGRAM_PLUGIN_PACKAGE_NAME,
    nodeModulesEntries: [
      {
        packageName: TELEGRAM_PLUGIN_PACKAGE_NAME,
        relativeEntryPath: "dist/index.js",
      },
    ],
    localEntries: TELEGRAM_PLUGIN_LOCAL_ENTRY_CANDIDATES,
  });
}

const LENS_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-lens";
const LENS_PLUGIN_FALLBACK_PACKAGE = "@elizaos-plugins/client-lens";
const LENS_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-lens/dist/index",
  "../../client-lens/dist/index",
  "../../client-lens/src/index",
] as const;

export function resolveLensPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: LENS_PLUGIN_PACKAGE_NAME,
    alternatePackageNames: [LENS_PLUGIN_FALLBACK_PACKAGE],
    nodeModulesEntries: [
      {
        packageName: LENS_PLUGIN_FALLBACK_PACKAGE,
        relativeEntryPath: "src/index.ts",
      },
      {
        packageName: LENS_PLUGIN_FALLBACK_PACKAGE,
        relativeEntryPath: "dist/index.js",
      },
    ],
    localEntries: LENS_PLUGIN_LOCAL_ENTRY_CANDIDATES,
  });
}

const FARCASTER_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-farcaster";
const FARCASTER_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-farcaster/dist/node/index.node.js",
] as const;

export function resolveFarcasterPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: FARCASTER_PLUGIN_PACKAGE_NAME,
    localEntries: FARCASTER_PLUGIN_LOCAL_ENTRY_CANDIDATES,
  });
}

const NOSTR_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-nostr";
const NOSTR_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-nostr/dist/index",
] as const;

export function resolveNostrPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: NOSTR_PLUGIN_PACKAGE_NAME,
    localEntries: NOSTR_PLUGIN_LOCAL_ENTRY_CANDIDATES,
  });
}

const MATRIX_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-matrix";
const MATRIX_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-matrix/dist/index",
] as const;

export function resolveMatrixPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: MATRIX_PLUGIN_PACKAGE_NAME,
    localEntries: MATRIX_PLUGIN_LOCAL_ENTRY_CANDIDATES,
  });
}

const FEISHU_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-feishu";
const FEISHU_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-feishu/dist/index",
] as const;

export function resolveFeishuPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: FEISHU_PLUGIN_PACKAGE_NAME,
    nodeModulesEntries: [
      {
        packageName: FEISHU_PLUGIN_PACKAGE_NAME,
        relativeEntryPath: "dist/index.js",
      },
    ],
    localEntries: FEISHU_PLUGIN_LOCAL_ENTRY_CANDIDATES,
  });
}

const WECHAT_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-wechat";
const WECHAT_PLUGIN_LEGACY_PACKAGE_NAME = "@elizaai/plugin-wechat";
const WECHAT_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "src/index.ts",
  "dist/index.js",
] as const;

export function resolveWechatPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: WECHAT_PLUGIN_PACKAGE_NAME,
    alternatePackageNames: [WECHAT_PLUGIN_LEGACY_PACKAGE_NAME],
    nodeModulesEntries: [
      ...WECHAT_PLUGIN_LOCAL_ENTRY_CANDIDATES.map((relativeEntryPath) => ({
        packageName: WECHAT_PLUGIN_PACKAGE_NAME,
        relativeEntryPath,
      })),
      ...WECHAT_PLUGIN_LOCAL_ENTRY_CANDIDATES.map((relativeEntryPath) => ({
        packageName: WECHAT_PLUGIN_LEGACY_PACKAGE_NAME,
        relativeEntryPath,
      })),
    ],
  });
}

/** Build a mock update check result with deterministic defaults. */
export function buildMockUpdateCheckResult(
  overrides: Partial<MockUpdateCheckResult> = {},
): MockUpdateCheckResult {
  return {
    updateAvailable: false,
    currentVersion: "2.0.0",
    latestVersion: "2.0.0",
    channel: "stable",
    distTag: "latest",
    cached: false,
    error: null,
    ...overrides,
  };
}

/** Small utility to wait for asynchronous side-effects in tests. */
export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type MockResponsePayload<T> = {
  res: MockHttpServerResponse;
  getStatus: () => number;
  getJson: () => T;
};

type MockHttpServerResponse = http.ServerResponse & {
  _status: number;
  _body: string;
  writeHead: (statusCode: number) => void;
};

type MockBodyChunk = string | Buffer;

export type MockRequestOptions = {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  bodyChunks?: MockBodyChunk[];
  json?: boolean;
};

/** Create a lightweight mocked HTTP response used by handler tests. */
export function createMockHttpResponse<T = unknown>(): MockResponsePayload<T> {
  let statusCode = 200;
  let legacyStatus = 0;
  let payload = "";

  const res = Object.create(ServerResponse.prototype) as MockHttpServerResponse;
  Object.defineProperty(res, "statusCode", {
    get() {
      return statusCode;
    },
    set(value: number) {
      statusCode = value;
      legacyStatus = value;
    },
    configurable: true,
  });
  res._status = legacyStatus;
  res._body = payload;
  res.setHeader = () => res;
  res.writeHead = ((value: number) => {
    statusCode = value;
    legacyStatus = value;
    return res;
  }) as MockHttpServerResponse["writeHead"];
  res.end = ((chunk?: string | Buffer) => {
    payload = chunk ? chunk.toString() : "";
    res._body = payload;
    legacyStatus = statusCode;
    res._status = legacyStatus;
    return res;
  }) as MockHttpServerResponse["end"];

  return {
    res,
    getStatus: () => statusCode,
    getJson: () => (payload ? (JSON.parse(payload) as T) : (null as T)),
  };
}

export function createMockHeadersRequest(
  headers: Record<string, string> = {},
  options: Omit<MockRequestOptions, "headers" | "body"> = {},
): http.IncomingMessage & { destroy: () => void } {
  return createMockIncomingMessage({
    ...options,
    headers,
  });
}

export function createMockIncomingMessage({
  method = "GET",
  url = "/",
  headers = { host: "localhost:2138" },
  body,
  bodyChunks,
  json = false,
}: MockRequestOptions): http.IncomingMessage & { destroy: () => void } {
  const req = new EventEmitter() as http.IncomingMessage &
    EventEmitter & { destroy: () => void };

  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = ((_: Error | undefined) => req) as typeof req.destroy;

  const chunks: Buffer[] = [];

  if (bodyChunks !== undefined) {
    for (const chunk of bodyChunks) {
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk,
      );
    }
  } else if (body !== undefined) {
    const encoded =
      typeof body === "string"
        ? Buffer.from(body, "utf-8")
        : body instanceof Buffer
          ? body
          : json
            ? Buffer.from(JSON.stringify(body), "utf-8")
            : Buffer.from(String(body), "utf-8");
    chunks.push(encoded);
  }

  for (const chunk of chunks) {
    queueMicrotask(() => req.emit("data", chunk));
  }
  queueMicrotask(() => req.emit("end"));

  return req;
}

export function createMockJsonRequest(
  body: unknown,
  options: Omit<MockRequestOptions, "body" | "json"> = {},
): http.IncomingMessage & { destroy: () => void } {
  return createMockIncomingMessage({
    ...options,
    body,
    json: true,
  });
}

/** Return true when optional plugin imports are intentionally unavailable in this env. */
export function isOptionalImportError(
  error: unknown,
  extraMarkers: readonly string[] = [],
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return OPTIONAL_IMPORT_ERROR_MARKERS.concat(extraMarkers).some((marker) =>
    message.includes(marker),
  );
}

/** Safely import optional plugin modules while allowing hard failures to bubble. */
export async function tryOptionalDynamicImport<T>(
  moduleName: string,
  markers?: readonly string[],
): Promise<T | null> {
  try {
    return (await import(/* @vite-ignore */ moduleName)) as T;
  } catch (error) {
    if (isOptionalImportError(error, markers)) return null;
    throw error;
  }
}
