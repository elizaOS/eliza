import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Test helper utilities shared across unit tests.
 */

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

/** Check whether a package name can be resolved for dynamic import. */
export function isPackageImportResolvable(packageName: string): boolean {
  const require = createRequire(import.meta.url);
  try {
    require.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

/** Check whether a dependency specifier should be treated as a workspace-local version. */
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
/**
 * Resolve the Discord plugin import specifier.
 * Prefers package resolution, then falls back to local plugin checkout paths.
 */
export function resolveDiscordPluginImportSpecifier(): string | null {
  if (isPackageImportResolvable(DISCORD_PLUGIN_PACKAGE_NAME)) {
    return DISCORD_PLUGIN_PACKAGE_NAME;
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(helperDir, "..", "..");

  for (const relativeEntryPath of DISCORD_PLUGIN_LOCAL_ENTRY_CANDIDATES) {
    const absoluteEntryPath = path.resolve(packageRoot, relativeEntryPath);
    if (existsSync(absoluteEntryPath)) {
      return pathToFileURL(absoluteEntryPath).href;
    }
  }

  return null;
}

const TELEGRAM_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-telegram";
const TELEGRAM_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-telegram/dist/index",
] as const;

/**
 * Resolve the Telegram plugin import specifier.
 * Prefers package resolution, then falls back to node_modules ESM entry
 * (the telegram plugin is ESM-only so CJS require.resolve fails), then
 * falls back to local plugin checkout paths.
 */
export function resolveTelegramPluginImportSpecifier(): string | null {
  if (isPackageImportResolvable(TELEGRAM_PLUGIN_PACKAGE_NAME)) {
    return TELEGRAM_PLUGIN_PACKAGE_NAME;
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(helperDir, "..", "..");

  // ESM-only: try direct node_modules entry
  const nodeModulesEntry = path.resolve(
    packageRoot,
    "node_modules",
    "@elizaos",
    "plugin-telegram",
    "dist",
    "index.js",
  );
  if (existsSync(nodeModulesEntry)) {
    return pathToFileURL(nodeModulesEntry).href;
  }

  for (const relativeEntryPath of TELEGRAM_PLUGIN_LOCAL_ENTRY_CANDIDATES) {
    const absoluteEntryPath = path.resolve(packageRoot, relativeEntryPath);
    if (existsSync(absoluteEntryPath)) {
      return pathToFileURL(absoluteEntryPath).href;
    }
  }

  return null;
}

const LENS_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-lens";
const LENS_PLUGIN_FALLBACK_PACKAGE = "@elizaos-plugins/client-lens";
const LENS_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-lens/dist/index",
  "../../client-lens/dist/index",
  "../../client-lens/src/index",
] as const;

/**
 * Resolve the Lens plugin import specifier.
 * Prefers package resolution, then falls back to local plugin checkout paths.
 * Uses both CJS require.resolve and a direct node_modules check for ESM-only packages.
 */
export function resolveLensPluginImportSpecifier(): string | null {
  if (isPackageImportResolvable(LENS_PLUGIN_PACKAGE_NAME)) {
    return LENS_PLUGIN_PACKAGE_NAME;
  }
  if (isPackageImportResolvable(LENS_PLUGIN_FALLBACK_PACKAGE)) {
    return LENS_PLUGIN_FALLBACK_PACKAGE;
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(helperDir, "..", "..");

  const nodeModulesSourceEntry = path.resolve(
    packageRoot,
    "node_modules",
    "@elizaos-plugins",
    "client-lens",
    "src",
    "index.ts",
  );
  if (existsSync(nodeModulesSourceEntry)) {
    return pathToFileURL(nodeModulesSourceEntry).href;
  }
  const nodeModulesDistEntry = path.resolve(
    packageRoot,
    "node_modules",
    "@elizaos-plugins",
    "client-lens",
    "dist",
    "index.js",
  );
  if (existsSync(nodeModulesDistEntry)) {
    return pathToFileURL(nodeModulesDistEntry).href;
  }

  for (const relativeEntryPath of LENS_PLUGIN_LOCAL_ENTRY_CANDIDATES) {
    const absoluteEntryPath = path.resolve(packageRoot, relativeEntryPath);
    if (existsSync(absoluteEntryPath)) {
      return pathToFileURL(absoluteEntryPath).href;
    }
  }

  return null;
}

const FARCASTER_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-farcaster";
const FARCASTER_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-farcaster/dist/node/index.node.js",
] as const;

/**
 * Resolve the Farcaster plugin import specifier.
 * Prefers package resolution, then falls back to local plugin checkout paths.
 */
export function resolveFarcasterPluginImportSpecifier(): string | null {
  if (isPackageImportResolvable(FARCASTER_PLUGIN_PACKAGE_NAME)) {
    return FARCASTER_PLUGIN_PACKAGE_NAME;
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(helperDir, "..", "..");

  for (const relativeEntryPath of FARCASTER_PLUGIN_LOCAL_ENTRY_CANDIDATES) {
    const absoluteEntryPath = path.resolve(packageRoot, relativeEntryPath);
    if (existsSync(absoluteEntryPath)) {
      return pathToFileURL(absoluteEntryPath).href;
    }
  }

  return null;
}

const NOSTR_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-nostr";
const NOSTR_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-nostr/dist/index",
] as const;

/**
 * Resolve the Nostr plugin import specifier.
 * Prefers package resolution, then falls back to local plugin checkout paths.
 */
export function resolveNostrPluginImportSpecifier(): string | null {
  if (isPackageImportResolvable(NOSTR_PLUGIN_PACKAGE_NAME)) {
    return NOSTR_PLUGIN_PACKAGE_NAME;
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(helperDir, "..", "..");

  for (const relativeEntryPath of NOSTR_PLUGIN_LOCAL_ENTRY_CANDIDATES) {
    const absoluteEntryPath = path.resolve(packageRoot, relativeEntryPath);
    if (existsSync(absoluteEntryPath)) {
      return pathToFileURL(absoluteEntryPath).href;
    }
  }

  return null;
}

const MATRIX_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-matrix";
const MATRIX_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-matrix/dist/index",
] as const;

/**
 * Resolve the Matrix plugin import specifier.
 * Prefers package resolution, then falls back to local plugin checkout paths.
 */
export function resolveMatrixPluginImportSpecifier(): string | null {
  if (isPackageImportResolvable(MATRIX_PLUGIN_PACKAGE_NAME)) {
    return MATRIX_PLUGIN_PACKAGE_NAME;
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(helperDir, "..", "..");

  for (const relativeEntryPath of MATRIX_PLUGIN_LOCAL_ENTRY_CANDIDATES) {
    const absoluteEntryPath = path.resolve(packageRoot, relativeEntryPath);
    if (existsSync(absoluteEntryPath)) {
      return pathToFileURL(absoluteEntryPath).href;
    }
  }

  return null;
}

const FEISHU_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-feishu";
const FEISHU_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "../plugins/plugin-feishu/dist/index",
] as const;

/**
 * Resolve the Feishu plugin import specifier.
 * Prefers package resolution, then falls back to local plugin checkout paths.
 */
export function resolveFeishuPluginImportSpecifier(): string | null {
  if (isPackageImportResolvable(FEISHU_PLUGIN_PACKAGE_NAME)) {
    return FEISHU_PLUGIN_PACKAGE_NAME;
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(helperDir, "..", "..");

  const nodeModulesDistEntry = path.resolve(
    packageRoot,
    "node_modules",
    "@elizaos",
    "plugin-feishu",
    "dist",
    "index.js",
  );
  if (existsSync(nodeModulesDistEntry)) {
    return pathToFileURL(nodeModulesDistEntry).href;
  }

  for (const relativeEntryPath of FEISHU_PLUGIN_LOCAL_ENTRY_CANDIDATES) {
    const absoluteEntryPath = path.resolve(packageRoot, relativeEntryPath);
    if (existsSync(absoluteEntryPath)) {
      return pathToFileURL(absoluteEntryPath).href;
    }
  }

  return null;
}

const WECHAT_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-wechat";
const WECHAT_PLUGIN_LEGACY_PACKAGE_NAME = "@elizaai/plugin-wechat";
const WECHAT_PLUGIN_LOCAL_ENTRY_CANDIDATES = [
  "src/index.ts",
  "dist/index.js",
] as const;

export function resolveWechatPluginImportSpecifier(): string | null {
  if (isPackageImportResolvable(WECHAT_PLUGIN_PACKAGE_NAME)) {
    return WECHAT_PLUGIN_PACKAGE_NAME;
  }
  if (isPackageImportResolvable(WECHAT_PLUGIN_LEGACY_PACKAGE_NAME)) {
    return WECHAT_PLUGIN_LEGACY_PACKAGE_NAME;
  }

  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(helperDir, "..", "..");

  // Check node_modules for either the canonical or legacy package name.
  for (const packageName of [
    WECHAT_PLUGIN_PACKAGE_NAME,
    WECHAT_PLUGIN_LEGACY_PACKAGE_NAME,
  ]) {
    const packageSegments = packageName.split("/");
    for (const relativeEntryPath of WECHAT_PLUGIN_LOCAL_ENTRY_CANDIDATES) {
      const nodeModulesEntry = path.resolve(
        packageRoot,
        "node_modules",
        ...packageSegments,
        relativeEntryPath,
      );
      if (existsSync(nodeModulesEntry)) {
        return pathToFileURL(nodeModulesEntry).href;
      }
    }
  }

  for (const relativeEntryPath of WECHAT_PLUGIN_LOCAL_ENTRY_CANDIDATES) {
    const nodeModulesEntry = path.resolve(
      packageRoot,
      "node_modules",
      "@elizaos",
      "plugin-wechat",
      relativeEntryPath,
    );
    if (existsSync(nodeModulesEntry)) {
      return pathToFileURL(nodeModulesEntry).href;
    }
  }

  return null;
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
  res: http.ServerResponse & {
    _status: number;
    _body: string;
    writeHead: (statusCode: number) => void;
  };
  getStatus: () => number;
  getJson: () => T;
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

  const res = {
    set statusCode(value: number) {
      statusCode = value;
      legacyStatus = value;
    },
    get statusCode() {
      return statusCode;
    },
    _status: legacyStatus,
    _body: payload,
    setHeader: () => undefined,
    writeHead: (value: number) => {
      statusCode = value;
      legacyStatus = value;
    },
    end: (chunk?: string | Buffer) => {
      payload = chunk ? chunk.toString() : "";
      res._body = payload;
      legacyStatus = statusCode;
      res._status = legacyStatus;
    },
  } as unknown as http.ServerResponse & {
    _status: number;
    _body: string;
    writeHead: (statusCode: number) => void;
  };

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
