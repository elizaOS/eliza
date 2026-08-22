/**
 * Resolves marketplace metadata through the production HTTP protocol. Only an
 * absent generated document may fall back to the flat index; corrupt or failed
 * authoritative responses never become a healthy index result.
 */
import { ElizaError } from "@elizaos/core";
import { isCloudReachable } from "@elizaos/shared";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

const DEFAULT_TIMEOUT_MS = 2_500;
const PACKAGE_NAME = /^(?:@[a-zA-Z0-9][\w.-]*\/)?[a-zA-Z0-9][\w.-]*$/;
const GITHUB_REPOSITORY = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export class RegistryNetworkFallbackError extends Error {
  readonly expectedLocalFallback = true;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryNetworkFallbackError";
  }
}

export class RegistryUpstreamError extends ElizaError {
  override readonly name = "RegistryUpstreamError";
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      code:
        options.status === undefined
          ? "REGISTRY_UPSTREAM_PROTOCOL_FAILED"
          : "REGISTRY_UPSTREAM_HTTP_FAILED",
      context: {
        status: options.status ?? null,
        retryAfterMs: options.retryAfterMs ?? null,
      },
      cause: options.cause,
      severity: options.status === 429 ? "ephemeral" : "fatal",
    });
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function isExpectedRegistryNetworkFallback(
  error: unknown,
): error is RegistryNetworkFallbackError {
  return (
    error instanceof RegistryNetworkFallbackError ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        error.message.toLowerCase().includes("timeout") ||
        error.message.toLowerCase().includes("timed out"))) ||
    (typeof error === "object" &&
      error !== null &&
      "expectedLocalFallback" in error &&
      (error as { expectedLocalFallback?: unknown }).expectedLocalFallback ===
        true)
  );
}

export interface RegistryNetworkCacheValidator {
  sourceUrl: string;
  etag: string;
  plugins: Map<string, RegistryPluginInfo>;
}

export interface RegistryNetworkSnapshot {
  sourceUrl: string;
  etag: string | null;
  plugins: Map<string, RegistryPluginInfo>;
  notModified: boolean;
}

export type RegistryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchFromNetworkParams {
  generatedRegistryUrl: string;
  indexRegistryUrl: string;
  applyLocalWorkspaceApps: (
    plugins: Map<string, RegistryPluginInfo>,
  ) => Promise<void>;
  applyNodeModulePlugins: (
    plugins: Map<string, RegistryPluginInfo>,
  ) => Promise<void>;
  sanitizeSandbox: (value?: string) => string;
  fetchImpl?: RegistryFetch;
  cloudReachable?: () => Promise<boolean>;
  timeoutMs?: number;
  now?: () => number;
  signal?: AbortSignal;
  cacheValidator?: RegistryNetworkCacheValidator | null;
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function record(value: unknown, field: string): JsonRecord {
  if (!isRecord(value))
    throw new RegistryUpstreamError(`${field} must be an object`);
  return value;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new RegistryUpstreamError(`${field} must be a string`);
  return value;
}
function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field);
}
function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new RegistryUpstreamError(`${field} must be boolean`);
  return value;
}
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  return value === undefined ? undefined : boolean(value, field);
}
function strings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new RegistryUpstreamError(`${field} must be a string array`);
  }
  return value;
}
function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RegistryUpstreamError(`${field} must be finite`);
  }
  return value;
}
function nullableNumber(value: unknown, field: string): number | null {
  return value === null ? null : number(value, field);
}

function validateUrl(raw: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    // error-policy:J2 preserve the parser cause in the typed boundary error.
    throw new RegistryUpstreamError(`${field} must be an absolute URL`, {
      cause,
    });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RegistryUpstreamError(
      `${field} must not contain credentials, query, or fragment`,
    );
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback)
  ) {
    throw new RegistryUpstreamError(
      `${field} must use HTTPS or literal loopback HTTP`,
    );
  }
  return parsed.toString();
}

function signal(params: FetchFromNetworkParams): AbortSignal {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RegistryUpstreamError(
      "Registry timeout must be an integer from 1 to 60000ms",
    );
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  return params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
}

function init(params: FetchFromNetworkParams, sourceUrl: string): RequestInit {
  const headers = new Headers({ accept: "application/json" });
  if (params.cacheValidator?.sourceUrl === sourceUrl) {
    headers.set("if-none-match", params.cacheValidator.etag);
  }
  return { headers, redirect: "error", signal: signal(params) };
}

function etag(response: Response): string | null {
  const value = response.headers.get("etag");
  if (!value) return null;
  if (value.length > 512 || /[\r\n]/.test(value)) {
    throw new RegistryUpstreamError("Registry ETag is malformed");
  }
  return value;
}

function retryAfterMs(response: Response, now: () => number): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now()) : null;
}

async function overlays(
  plugins: Map<string, RegistryPluginInfo>,
  params: FetchFromNetworkParams,
): Promise<void> {
  await params.applyLocalWorkspaceApps(plugins);
  await params.applyNodeModulePlugins(plugins);
}

function cached(
  params: FetchFromNetworkParams,
  sourceUrl: string,
  response: Response,
): RegistryNetworkSnapshot {
  const validator = params.cacheValidator;
  if (!validator || validator.sourceUrl !== sourceUrl) {
    throw new RegistryUpstreamError(
      "Registry returned 304 without a matching cache",
      {
        status: response.status,
      },
    );
  }
  return {
    sourceUrl,
    etag: etag(response) ?? validator.etag,
    plugins: new Map(validator.plugins),
    notModified: true,
  };
}

function parseEntry(
  name: string,
  raw: unknown,
  sanitizeSandbox: (value?: string) => string,
): RegistryPluginInfo {
  if (!PACKAGE_NAME.test(name))
    throw new RegistryUpstreamError(`Invalid package ${name}`);
  const entry = record(raw, name);
  const git = record(entry.git, `${name}.git`);
  const npm = record(entry.npm, `${name}.npm`);
  const supports = record(entry.supports, `${name}.supports`);
  const repo = string(git.repo, `${name}.git.repo`);
  const npmPackage = string(npm.repo, `${name}.npm.repo`);
  if (!GITHUB_REPOSITORY.test(repo) || !PACKAGE_NAME.test(npmPackage)) {
    throw new RegistryUpstreamError(`Invalid registry identity for ${name}`);
  }
  const branch = (key: "v0" | "v1" | "v2") =>
    nullableString(
      record(git[key], `${name}.git.${key}`).branch,
      `${name}.git.${key}.branch`,
    );
  const version = (key: "v0" | "v1" | "v2") =>
    nullableString(npm[key], `${name}.npm.${key}`);
  const info: RegistryPluginInfo = {
    name,
    gitRepo: repo,
    gitUrl: `https://github.com/${repo}.git`,
    directory:
      entry.directory === undefined
        ? null
        : nullableString(entry.directory, `${name}.directory`),
    description: string(entry.description, `${name}.description`),
    homepage: nullableString(entry.homepage, `${name}.homepage`),
    topics: strings(entry.topics, `${name}.topics`),
    stars: number(entry.stargazers_count, `${name}.stargazers_count`),
    language: string(entry.language, `${name}.language`),
    npm: {
      package: npmPackage,
      v0Version: version("v0"),
      v1Version: version("v1"),
      v2Version: version("v2"),
    },
    git: {
      v0Branch: branch("v0"),
      v1Branch: branch("v1"),
      v2Branch: branch("v2"),
    },
    supports: {
      v0: boolean(supports.v0, `${name}.supports.v0`),
      v1: boolean(supports.v1, `${name}.supports.v1`),
      v2: boolean(supports.v2, `${name}.supports.v2`),
    },
    origin: optionalString(entry.origin, `${name}.origin`),
    source: optionalString(entry.source, `${name}.source`),
    support: optionalString(entry.support, `${name}.support`),
    builtIn: optionalBoolean(entry.builtIn, `${name}.builtIn`),
    firstParty: optionalBoolean(entry.firstParty, `${name}.firstParty`),
    thirdParty: optionalBoolean(entry.thirdParty, `${name}.thirdParty`),
    status: optionalString(entry.status, `${name}.status`),
    registryKind: optionalString(entry.registryKind, `${name}.registryKind`),
  };
  const kind = optionalString(entry.kind, `${name}.kind`);
  if (kind) info.kind = kind;
  if (entry.app !== undefined) {
    const app = record(entry.app, `${name}.app`);
    info.kind = "app";
    info.appMeta = {
      displayName: string(app.displayName, `${name}.app.displayName`),
      category: string(app.category, `${name}.app.category`),
      launchType: string(app.launchType, `${name}.app.launchType`),
      launchUrl: nullableString(app.launchUrl, `${name}.app.launchUrl`),
      icon: nullableString(app.icon, `${name}.app.icon`),
      heroImage:
        app.heroImage === undefined
          ? null
          : nullableString(app.heroImage, `${name}.app.heroImage`),
      capabilities: strings(app.capabilities, `${name}.app.capabilities`),
      minPlayers: nullableNumber(app.minPlayers, `${name}.app.minPlayers`),
      maxPlayers: nullableNumber(app.maxPlayers, `${name}.app.maxPlayers`),
      runtimePlugin: optionalString(
        app.runtimePlugin,
        `${name}.app.runtimePlugin`,
      ),
      bridgeExport: optionalString(
        app.bridgeExport,
        `${name}.app.bridgeExport`,
      ),
      developerOnly: optionalBoolean(
        app.developerOnly,
        `${name}.app.developerOnly`,
      ),
      visibleInAppStore: optionalBoolean(
        app.visibleInAppStore,
        `${name}.app.visibleInAppStore`,
      ),
      mainTab: optionalBoolean(app.mainTab, `${name}.app.mainTab`),
      catalogSection: optionalString(
        app.catalogSection,
        `${name}.app.catalogSection`,
      ),
      featured: optionalBoolean(app.featured, `${name}.app.featured`),
      defaultHidden: optionalBoolean(
        app.defaultHidden,
        `${name}.app.defaultHidden`,
      ),
      scope: optionalString(app.scope, `${name}.app.scope`),
    };
    if (app.uiExtension !== undefined) {
      const uiExtension = record(app.uiExtension, `${name}.app.uiExtension`);
      info.appMeta.uiExtension = {
        detailPanelId: string(
          uiExtension.detailPanelId,
          `${name}.app.uiExtension.detailPanelId`,
        ),
      };
    }
    if (app.session !== undefined) {
      const session = record(app.session, `${name}.app.session`);
      const mode = string(session.mode, `${name}.app.session.mode`);
      if (!new Set(["viewer", "spectate-and-steer", "external"]).has(mode)) {
        throw new RegistryUpstreamError(`${name}.app.session.mode is invalid`);
      }
      const features =
        session.features === undefined
          ? undefined
          : strings(session.features, `${name}.app.session.features`);
      const allowedFeatures = new Set([
        "commands",
        "telemetry",
        "pause",
        "resume",
        "suggestions",
      ]);
      if (features?.some((feature) => !allowedFeatures.has(feature))) {
        throw new RegistryUpstreamError(
          `${name}.app.session.features is invalid`,
        );
      }
      info.appMeta.session = {
        mode: mode as "viewer" | "spectate-and-steer" | "external",
        features: features as
          | Array<"commands" | "telemetry" | "pause" | "resume" | "suggestions">
          | undefined,
      };
    }
    if (app.viewer !== undefined) {
      const viewer = record(app.viewer, `${name}.app.viewer`);
      const embed = viewer.embedParams;
      if (
        embed !== undefined &&
        (!isRecord(embed) ||
          !Object.values(embed).every((v) => typeof v === "string"))
      ) {
        throw new RegistryUpstreamError(
          `${name}.app.viewer.embedParams is invalid`,
        );
      }
      info.appMeta.viewer = {
        url: string(viewer.url, `${name}.app.viewer.url`),
        embedParams: embed as Record<string, string> | undefined,
        postMessageAuth: optionalBoolean(
          viewer.postMessageAuth,
          `${name}.app.viewer.postMessageAuth`,
        ),
        sandbox: sanitizeSandbox(
          optionalString(viewer.sandbox, `${name}.app.viewer.sandbox`),
        ),
      };
    }
  }
  return info;
}

async function requestJson(
  params: FetchFromNetworkParams,
  sourceUrl: string,
  operation: string,
  allowNotFound: boolean,
): Promise<Response | null> {
  const span = createIntegrationTelemetrySpan({
    boundary: "marketplace",
    operation,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  let response: Response;
  try {
    response = await (params.fetchImpl ?? fetch)(
      sourceUrl,
      init(params, sourceUrl),
    );
  } catch (cause) {
    // error-policy:J2 retain the transport cause in a typed upstream failure.
    span.failure({ error: cause });
    throw new RegistryUpstreamError(`${operation} request failed`, {
      cause,
    });
  }
  if (allowNotFound && response.status === 404) return null;
  if (response.status !== 304 && !response.ok) {
    span.failure({ statusCode: response.status, errorKind: "http_error" });
    throw new RegistryUpstreamError(
      `${operation} failed with HTTP ${response.status}`,
      {
        status: response.status,
        retryAfterMs: retryAfterMs(response, params.now ?? Date.now),
      },
    );
  }
  span.success({ statusCode: response.status });
  return response;
}

async function generated(
  params: FetchFromNetworkParams,
  sourceUrl: string,
): Promise<RegistryNetworkSnapshot | null> {
  const response = await requestJson(
    params,
    sourceUrl,
    "fetch_generated_registry",
    true,
  );
  if (!response) return null;
  if (response.status === 304) {
    const snapshot = cached(params, sourceUrl, response);
    await overlays(snapshot.plugins, params);
    return snapshot;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    // error-policy:J2 retain the JSON parser cause in the typed upstream failure.
    throw new RegistryUpstreamError(
      "Generated registry returned malformed JSON",
      { cause },
    );
  }
  const registry = record(record(body, "root").registry, "registry");
  const plugins = new Map<string, RegistryPluginInfo>();
  for (const [name, entry] of Object.entries(registry)) {
    plugins.set(name, parseEntry(name, entry, params.sanitizeSandbox));
  }
  await overlays(plugins, params);
  return { sourceUrl, etag: etag(response), plugins, notModified: false };
}

async function index(
  params: FetchFromNetworkParams,
  sourceUrl: string,
): Promise<RegistryNetworkSnapshot> {
  const response = await requestJson(
    params,
    sourceUrl,
    "fetch_index_registry",
    false,
  );
  if (!response)
    throw new RegistryUpstreamError("Index registry unexpectedly absent");
  if (response.status === 304) {
    const snapshot = cached(params, sourceUrl, response);
    await overlays(snapshot.plugins, params);
    return snapshot;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    // error-policy:J2 retain the JSON parser cause in the typed upstream failure.
    throw new RegistryUpstreamError("Index registry returned malformed JSON", {
      cause,
    });
  }
  const plugins = new Map<string, RegistryPluginInfo>();
  for (const [name, rawRef] of Object.entries(record(body, "index"))) {
    if (!PACKAGE_NAME.test(name))
      throw new RegistryUpstreamError(`Invalid package ${name}`);
    const repo = string(rawRef, name).replace(/^github:/, "");
    if (!GITHUB_REPOSITORY.test(repo))
      throw new RegistryUpstreamError(`Invalid repository for ${name}`);
    const builtIn = name.startsWith("@elizaos/");
    plugins.set(name, {
      name,
      gitRepo: repo,
      gitUrl: `https://github.com/${repo}.git`,
      directory: null,
      description: "",
      homepage: null,
      topics: [],
      stars: 0,
      language: "TypeScript",
      npm: { package: name, v0Version: null, v1Version: null, v2Version: null },
      git: { v0Branch: null, v1Branch: null, v2Branch: "next" },
      supports: { v0: false, v1: false, v2: false },
      origin: builtIn ? "builtin" : "third-party",
      source: builtIn ? "builtin" : "third-party",
      support: builtIn ? "first-party" : "community",
      builtIn,
      firstParty: builtIn,
      thirdParty: !builtIn,
    });
  }
  await overlays(plugins, params);
  return { sourceUrl, etag: etag(response), plugins, notModified: false };
}

/** Resolve a network snapshot, preferring generated metadata over the index. */
export async function fetchRegistrySnapshot(
  params: FetchFromNetworkParams,
): Promise<RegistryNetworkSnapshot> {
  const generatedUrl = validateUrl(
    params.generatedRegistryUrl,
    "generatedRegistryUrl",
  );
  const indexUrl = validateUrl(params.indexRegistryUrl, "indexRegistryUrl");
  if (!(await (params.cloudReachable ?? isCloudReachable)())) {
    throw new RegistryNetworkFallbackError(
      "cloud unreachable at boot — using local registry snapshot",
    );
  }
  return (await generated(params, generatedUrl)) ?? index(params, indexUrl);
}

/** Compatibility wrapper for callers that only need the plugin map. */
export async function fetchFromNetwork(
  params: FetchFromNetworkParams,
): Promise<Map<string, RegistryPluginInfo>> {
  return (await fetchRegistrySnapshot(params)).plugins;
}
