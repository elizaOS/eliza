/**
 * Health, status, and runtime-introspection routes for the local agent server:
 * `GET /api/status` (agent state, active model, uptime, cloud-connection and
 * pending-restart summary), `GET /api/health` (subsystem readiness — runtime,
 * plugins loaded/failed, service registrations including failed starts, swarm
 * coordinator, connector statuses), and
 * `GET /api/runtime` (deep, memoized reflective snapshot of the runtime object
 * graph for the debug UI).
 *
 * Read-only introspection; both status endpoints treat optional local-inference
 * and cloud health as best-effort and degrade rather than 500. Also exports
 * `computeCanRespond`, the shared "first-turn capability online" predicate
 * (live runtime AND `running` AND a registered text-generation handler AND available
 * weights when the sole provider is local inference AND no
 * cached Cloud catalog answer that the only text provider's model is gone) reused
 * by `/api/status`, `/api/health`, and the WS `status` broadcast.
 */
import type http from "node:http";
import {
  type AgentRuntime,
  getSwarmCoordinatorService,
  ModelType,
  parseCanonicalInteger,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { hasTextGenerationHandler } from "@elizaos/plugin-assistant";
import { isCloudProvisionedContainer } from "@elizaos/plugin-elizacloud/cloud-config/cloud-provisioning";
import { createDevCloudConfigAuthorityView } from "../config/dev-cloud-env-authority.ts";
import { getDeferredBootStatus } from "../runtime/deferred-boot-status.ts";
import { detectRuntimeModel } from "./agent-model.ts";
import type { ConnectorHealthMonitor } from "./connector-health.ts";
import { probeRuntimeDatabaseLiveness } from "./database-liveness.ts";
import { loadLocalInferenceRouteApi } from "./local-inference-server-api.ts";
import { isTrustedLocalRequest } from "./server-helpers-auth.ts";

// Pure env detector lives in shared so status can report managed hosting mode
// without loading the full cloud plugin graph (which may fail in lean test
// harnesses or partial installs).
type CloudApiKeyResolver = {
  resolveCloudApiKey: (
    config: ElizaConfig,
    runtime: AgentRuntime | null,
  ) => string | undefined;
};
let cloudApiKeyResolverPromise: Promise<CloudApiKeyResolver> | null = null;
function getCloudApiKeyResolver(): Promise<CloudApiKeyResolver> {
  cloudApiKeyResolverPromise ??= import(
    "@elizaos/plugin-elizacloud"
  ) as Promise<CloudApiKeyResolver>;
  return cloudApiKeyResolverPromise;
}
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PluginEntryLike {
  enabled: boolean;
  configured: boolean;
  isActive?: boolean;
  loadError?: string | null;
}
interface AgentStartupDiagnostics {
  phase: string;
  attempt: number;
  lastError?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
}
export interface HealthRouteState {
  runtime: AgentRuntime | null;
  config: ElizaConfig;
  agentState: string;
  agentName: string;
  model: string | undefined;
  startedAt: number | undefined;
  startup: AgentStartupDiagnostics;
  plugins: PluginEntryLike[];
  pendingRestartReasons: string[];
  connectorHealthMonitor: ConnectorHealthMonitor | null;
}
/** Trusted host composition before status JSON is serialized. */
export type ApiStatusComposer = (
  payload: Record<string, unknown>,
) => Record<string, unknown>;

export interface HealthRouteContext {
  composeStatus?: ApiStatusComposer;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: HealthRouteState;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
}
// ---------------------------------------------------------------------------
// Runtime debug utilities (only used by GET /api/runtime)
// ---------------------------------------------------------------------------
const RUNTIME_DEBUG_DEFAULT_MAX_DEPTH = 10;
const RUNTIME_DEBUG_MAX_DEPTH_CAP = 24;
const RUNTIME_DEBUG_DEFAULT_MAX_ARRAY_LENGTH = 1000;
const RUNTIME_DEBUG_DEFAULT_MAX_OBJECT_ENTRIES = 1000;
const RUNTIME_DEBUG_DEFAULT_MAX_STRING_LENGTH = 8000;
interface RuntimeDebugSerializeOptions {
  maxDepth: number;
  maxArrayLength: number;
  maxObjectEntries: number;
  maxStringLength: number;
}
/**
 * /api/runtime serializes the entire runtime object graph (six deep reflective
 * walks). RuntimeView re-requests on depth/cap changes and may revalidate
 * repeatedly, so the snapshot is memoized for a short window keyed by the
 * serialize options and guarded by runtime identity — a restart swaps the
 * runtime reference and forces a fresh build.
 */
const RUNTIME_DEBUG_SNAPSHOT_TTL_MS = 2500;
interface RuntimeDebugSnapshotCacheEntry {
  payload: unknown;
  builtAt: number;
  runtime: object;
}
const runtimeDebugSnapshotCache = new Map<
  string,
  RuntimeDebugSnapshotCacheEntry
>();
function getCachedRuntimeDebugSnapshot<T>(
  runtime: object,
  options: RuntimeDebugSerializeOptions,
  build: () => T,
): T {
  const key = `${options.maxDepth}:${options.maxArrayLength}:${options.maxObjectEntries}:${options.maxStringLength}`;
  const existing = runtimeDebugSnapshotCache.get(key);
  const now = Date.now();
  if (
    existing &&
    existing.runtime === runtime &&
    now - existing.builtAt < RUNTIME_DEBUG_SNAPSHOT_TTL_MS
  ) {
    return existing.payload as T;
  }
  const payload = build();
  runtimeDebugSnapshotCache.set(key, { payload, builtAt: now, runtime });
  return payload;
}
interface RuntimeOrderItem {
  index: number;
  name: string;
  className: string;
  id: string | null;
}
interface RuntimeServiceOrderItem {
  index: number;
  serviceType: string;
  count: number;
  instances: RuntimeOrderItem[];
}
export function parseDebugPositiveInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | "invalid" {
  if (raw === null || raw === "") return fallback;
  const parsed = parseCanonicalInteger(raw, { min, max, clamp: true });
  return parsed === undefined ? fallback : parsed;
}
function classNameFor(value: object): string {
  const ctor = (
    value as {
      constructor?: {
        name?: string;
      };
    }
  ).constructor;
  const maybeName = typeof ctor?.name === "string" ? ctor.name.trim() : "";
  return maybeName || "Object";
}
function stringDataProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return null;
  const maybeString = descriptor.value;
  if (typeof maybeString !== "string") return null;
  const trimmed = maybeString.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function describeRuntimeOrder(
  values: unknown[],
  fallbackLabel: string,
): RuntimeOrderItem[] {
  return values.map((value, index) => {
    const className =
      value && typeof value === "object" ? classNameFor(value) : typeof value;
    const name =
      stringDataProperty(value, "name") ??
      stringDataProperty(value, "id") ??
      stringDataProperty(value, "key") ??
      stringDataProperty(value, "serviceType") ??
      `${fallbackLabel} ${index + 1}`;
    const id =
      stringDataProperty(value, "id") ?? stringDataProperty(value, "name");
    return { index, name, className, id };
  });
}
function describeRuntimeServiceOrder(
  servicesMap: Map<string, unknown[]>,
): RuntimeServiceOrderItem[] {
  return Array.from(servicesMap.entries()).map(
    ([serviceType, instances], i) => {
      const values = Array.isArray(instances) ? instances : [];
      return {
        index: i,
        serviceType,
        count: values.length,
        instances: describeRuntimeOrder(values, serviceType),
      };
    },
  );
}
export function serializeForRuntimeDebug(
  value: unknown,
  options: RuntimeDebugSerializeOptions,
): unknown {
  const seen = new WeakMap<object, string>();
  const visit = (current: unknown, path: string, depth: number): unknown => {
    if (current === null) return null;
    const kind = typeof current;
    if (kind === "string") {
      if ((current as string).length <= options.maxStringLength) return current;
      const wellFormedString = toWellFormedUnicode(current as string);
      const max = options.maxStringLength;
      let preview: string;
      if (max <= 0) {
        preview = "";
      } else if (max <= 3) {
        preview = truncateWellFormed(wellFormedString, max);
      } else {
        preview = `${truncateWellFormed(wellFormedString, max - 3)}...`;
      }
      return {
        __type: "string",
        length: (current as string).length,
        preview,
        truncated: true,
      };
    }
    if (kind === "number") {
      const n = current as number;
      if (Number.isFinite(n)) return n;
      return { __type: "number", value: String(n) };
    }
    if (kind === "boolean") return current;
    if (kind === "bigint") return { __type: "bigint", value: String(current) };
    if (kind === "undefined") return { __type: "undefined" };
    if (kind === "symbol") return { __type: "symbol", value: String(current) };
    if (kind === "function") {
      const fn = current as (...args: unknown[]) => unknown;
      return {
        __type: "function",
        name: fn.name || "(anonymous)",
        length: fn.length,
      };
    }
    const obj = current as object;
    if (obj instanceof Date) {
      return { __type: "date", value: obj.toISOString() };
    }
    if (obj instanceof RegExp) {
      return { __type: "regexp", value: String(obj) };
    }
    if (obj instanceof Error) {
      const err = obj as Error & {
        cause?: unknown;
      };
      const out: Record<string, unknown> = {
        __type: "error",
        name: err.name,
        message: err.message,
      };
      if (err.stack) {
        const wellFormedStack = toWellFormedUnicode(err.stack);
        if (wellFormedStack.length > options.maxStringLength) {
          const max = options.maxStringLength;
          if (max <= 0) {
            out.stack = "";
          } else if (max <= 3) {
            out.stack = truncateWellFormed(wellFormedStack, max);
          } else {
            out.stack = `${truncateWellFormed(wellFormedStack, max - 3)}...`;
          }
        } else {
          out.stack = wellFormedStack;
        }
      }
      if (err.cause !== undefined) {
        out.cause = visit(err.cause, `${path}.cause`, depth + 1);
      }
      return out;
    }
    if (Buffer.isBuffer(obj)) {
      const previewLength = Math.min(obj.length, 64);
      return {
        __type: "buffer",
        length: obj.length,
        previewHex: obj.subarray(0, previewLength).toString("hex"),
        truncated: obj.length > previewLength,
      };
    }
    if (ArrayBuffer.isView(obj)) {
      const view = obj as ArrayBufferView;
      const previewLength = Math.min(view.byteLength, 64);
      const bytes = new Uint8Array(view.buffer, view.byteOffset, previewLength);
      return {
        __type: classNameFor(obj),
        byteLength: view.byteLength,
        previewHex: Buffer.from(bytes).toString("hex"),
        truncated: view.byteLength > previewLength,
      };
    }
    if (obj instanceof ArrayBuffer) {
      const previewLength = Math.min(obj.byteLength, 64);
      const bytes = new Uint8Array(obj, 0, previewLength);
      return {
        __type: "array-buffer",
        byteLength: obj.byteLength,
        previewHex: Buffer.from(bytes).toString("hex"),
        truncated: obj.byteLength > previewLength,
      };
    }
    const seenPath = seen.get(obj);
    if (seenPath) return { __type: "circular", ref: seenPath };
    if (depth >= options.maxDepth) {
      return {
        __type: "max-depth",
        className: classNameFor(obj),
        path,
      };
    }
    seen.set(obj, path);
    if (Array.isArray(obj)) {
      const arr = obj as unknown[];
      const limit = Math.min(arr.length, options.maxArrayLength);
      const items = new Array<unknown>(limit);
      for (let i = 0; i < limit; i++) {
        items[i] = visit(arr[i], `${path}[${i}]`, depth + 1);
      }
      const out: Record<string, unknown> = {
        __type: "array",
        length: arr.length,
        items,
      };
      if (arr.length > limit) out.truncatedItems = arr.length - limit;
      return out;
    }
    if (obj instanceof Map) {
      const entries: Array<{
        key: unknown;
        value: unknown;
      }> = [];
      let i = 0;
      for (const [entryKey, entryValue] of obj.entries()) {
        if (i >= options.maxObjectEntries) break;
        entries.push({
          key: visit(entryKey, `${path}.<key:${i}>`, depth + 1),
          value: visit(entryValue, `${path}.<value:${i}>`, depth + 1),
        });
        i += 1;
      }
      const out: Record<string, unknown> = {
        __type: "map",
        size: obj.size,
        entries,
      };
      if (obj.size > entries.length) {
        out.truncatedEntries = obj.size - entries.length;
      }
      return out;
    }
    if (obj instanceof Set) {
      const values: unknown[] = [];
      let i = 0;
      for (const entry of obj.values()) {
        if (i >= options.maxArrayLength) break;
        values.push(visit(entry, `${path}.<set:${i}>`, depth + 1));
        i += 1;
      }
      const out: Record<string, unknown> = {
        __type: "set",
        size: obj.size,
        values,
      };
      if (obj.size > values.length)
        out.truncatedEntries = obj.size - values.length;
      return out;
    }
    if (obj instanceof WeakMap) {
      return { __type: "weak-map" };
    }
    if (obj instanceof WeakSet) {
      return { __type: "weak-set" };
    }
    if (obj instanceof Promise) {
      return { __type: "promise" };
    }
    const ownNames = Object.getOwnPropertyNames(obj);
    const ownSymbols = Object.getOwnPropertySymbols(obj);
    const allKeys: Array<string | symbol> = [...ownNames, ...ownSymbols];
    const limit = Math.min(allKeys.length, options.maxObjectEntries);
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < limit; i++) {
      const propertyKey = allKeys[i];
      const keyLabel =
        typeof propertyKey === "string"
          ? propertyKey
          : `[${String(propertyKey)}]`;
      const descriptor = Object.getOwnPropertyDescriptor(obj, propertyKey);
      if (!descriptor) continue;
      if ("value" in descriptor) {
        properties[keyLabel] = visit(
          descriptor.value,
          `${path}.${keyLabel}`,
          depth + 1,
        );
      } else {
        properties[keyLabel] = {
          __type: "accessor",
          hasGetter: typeof descriptor.get === "function",
          hasSetter: typeof descriptor.set === "function",
          enumerable: descriptor.enumerable,
        };
      }
    }
    if (allKeys.length > limit) {
      properties.__truncatedKeys = allKeys.length - limit;
    }
    const prototype = Object.getPrototypeOf(obj);
    const isPlainObject = prototype === Object.prototype || prototype === null;
    if (isPlainObject) return properties;
    return {
      __type: "object",
      className: classNameFor(obj),
      properties,
    };
  };
  return visit(value, "$", 0);
}
// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
/**
 * "First-turn capability online": the agent can actually produce a response.
 *
 * Distinct from `ready` (which is `true` even for stopped/error/paused states —
 * it only negates `starting`/`restarting`). `canRespond` ANDs a live runtime, a
 * `running` state, AND a registered TEXT_GENERATION handler — so it is `false`
 * when no model provider is wired or the sole local handler has no usable weights, and only flips
 * `true` at the exact moment the agent can answer a first turn. This is the
 * signal the UI uses to fade in first-turn capability: the shell paints early
 * (agentState "starting"), and the composer goes live when this flips.
 *
 * The local-inference router counts as a handler to the runtime, but it only
 * dispatches to the other registered text handlers, so a runtime whose text
 * slots hold nothing but the router cannot answer a turn.
 */
export function computeCanRespond(
  runtime: AgentRuntime | null,
  agentState: string,
  localModelReadiness: Awaited<ReturnType<typeof readLocalTextModelReadiness>>,
): boolean {
  if (!runtime || agentState !== "running") {
    return false;
  }
  try {
    if (!hasTextGenerationHandler(runtime)) return false;
    if (!textRegistrationsBehindRouter(runtime).length) return false;
    if (localModelReadiness?.status === "model_not_loaded") return false;
  } catch {
    return false;
  }
  return !isCloudTextModelUnavailable(runtime);
}

const LOCAL_INFERENCE_ROUTER_PROVIDER = "eliza-router";

const TEXT_MODEL_TYPES: ReadonlySet<string> = new Set([
  ModelType.TEXT_LARGE,
  ModelType.TEXT_SMALL,
  ModelType.TEXT_MEDIUM,
  ModelType.TEXT_NANO,
  ModelType.TEXT_MEGA,
  ModelType.ACTION_PLANNER,
  ModelType.RESPONSE_HANDLER,
]);

/**
 * Text-slot registrations that can serve a turn. The local-inference plugin
 * fronts its text slots with a prefer-local router (`ROUTER_PROVIDER` in
 * router-handler.ts). It dispatches to the other registered handlers and
 * serves nothing itself, so it neither makes a runtime "mixed" nor needs
 * weights of its own, and it is left out here.
 */
function textRegistrationsBehindRouter(
  runtime: AgentRuntime,
): Array<{ modelType: string; provider: string }> {
  return runtime
    .getModelRegistrations()
    .filter(
      (entry) =>
        TEXT_MODEL_TYPES.has(entry.modelType) &&
        entry.provider !== LOCAL_INFERENCE_ROUTER_PROVIDER,
    );
}

/** Readiness of this runtime's sole local text provider, without loading models. */
export async function readLocalTextModelReadiness(
  runtime: AgentRuntime | null,
): Promise<{
  provider: "eliza-local-inference";
  status: "available" | "model_not_loaded";
} | null> {
  if (!runtime) return null;
  try {
    const registrations = textRegistrationsBehindRouter(runtime);
    if (
      !registrations.length ||
      registrations.some((entry) => entry.provider !== "eliza-local-inference")
    )
      return null;
    const { hasLocalTextModelAvailable } = await loadLocalInferenceRouteApi();
    const available = await hasLocalTextModelAvailable(
      runtime,
      registrations.map((entry) => entry.modelType),
    );
    return {
      provider: "eliza-local-inference",
      status: available ? "available" : "model_not_loaded",
    };
  } catch (error) {
    // error-policy:J7 An unreadable readiness source is unknown, not evidence
    // of missing weights or permission to block another provider.
    runtime.logger.warn(
      { src: "health-routes", error },
      "Local model readiness unavailable",
    );
    return null;
  }
}

/** One readiness snapshot for HTTP and WebSocket status payloads. */
export async function responseReadinessFields(
  runtime: AgentRuntime | null,
  agentState: string,
) {
  const localModelReadiness = await readLocalTextModelReadiness(runtime);
  return {
    canRespond: computeCanRespond(runtime, agentState, localModelReadiness),
    ...cloudModelReadinessField(runtime),
    localModelReadiness,
  };
}

/**
 * `{ modelReadiness }` for status payloads when the Cloud model registry is
 * running, so clients can tell an invalid model setting apart from a provider
 * outage or a missing provider.
 */
export function cloudModelReadinessField(runtime: AgentRuntime | null): {
  modelReadiness?: CloudModelReadinessView;
} {
  const readiness = readCloudModelReadiness(runtime);
  return readiness ? { modelReadiness: readiness } : {};
}

/** Provider name the elizacloud plugin registers its text handlers under. */
const ELIZA_CLOUD_TEXT_PROVIDER = "elizaOSCloud";
const CLOUD_MODEL_REGISTRY_SERVICE = "CLOUD_MODEL_REGISTRY";

/**
 * Status projection of the Cloud model registry's text-model readiness
 * (plugins/plugin-elizacloud/src/services/cloud-model-readiness.ts). Read
 * structurally so the status route does not load the Cloud plugin graph.
 */
export type CloudModelReadinessView =
  | { status: "available"; checkedAt: number }
  | { status: "unknown"; reason: string; checkedAt: number | null }
  | {
      status: "model_not_available";
      code: "MODEL_NOT_AVAILABLE";
      missing: Array<{
        modelType: "TEXT_SMALL" | "TEXT_LARGE";
        configKey: string | null;
        modelId: string;
      }>;
      message: string;
      checkedAt: number;
    };

type CloudModelReadinessSource = {
  getTextModelReadiness: () => CloudModelReadinessView;
};

function isCloudModelReadinessSource(
  value: unknown,
): value is CloudModelReadinessSource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getTextModelReadiness?: unknown })
      .getTextModelReadiness === "function"
  );
}

/**
 * Cached Cloud catalog readiness for the configured TEXT_SMALL/TEXT_LARGE ids,
 * or null when the Cloud model registry is not running. Never performs an
 * inference call; the registry refreshes its catalog in the background.
 */
export function readCloudModelReadiness(
  runtime: AgentRuntime | null,
): CloudModelReadinessView | null {
  if (!runtime) return null;
  try {
    const service = runtime.getService(CLOUD_MODEL_REGISTRY_SERVICE);
    if (!isCloudModelReadinessSource(service)) return null;
    return service.getTextModelReadiness();
  } catch (error) {
    // error-policy:J7 readiness is a status input; an unreadable registry is
    // "unknown", which keeps the handler-registration answer (fail open).
    runtime.logger.warn(
      {
        src: "health-routes",
        error: error instanceof Error ? error.message : String(error),
      },
      "Cloud model readiness unavailable",
    );
    return null;
  }
}

/**
 * True only on a positive catalog answer that a configured Cloud text model id
 * is not listed AND Eliza Cloud is the sole registered provider for that model
 * type, so no failover can serve it. Catalog outages stay `unknown` and never
 * gate chat (#30228). The local-inference router is not a failover: it can
 * only dispatch to the providers counted here.
 */
function isCloudTextModelUnavailable(runtime: AgentRuntime): boolean {
  const readiness = readCloudModelReadiness(runtime);
  if (readiness?.status !== "model_not_available") return false;
  let registrations: Array<{ modelType: string; provider: string }>;
  try {
    registrations = runtime.getModelRegistrations?.() ?? [];
  } catch {
    return false;
  }
  return readiness.missing.some(({ modelType }) => {
    const providers = registrations
      .filter(
        (entry) =>
          entry.modelType === modelType &&
          entry.provider !== LOCAL_INFERENCE_ROUTER_PROVIDER,
      )
      .map((entry) => entry.provider);
    return (
      providers.length > 0 &&
      providers.every((provider) => provider === ELIZA_CLOUD_TEXT_PROVIDER)
    );
  });
}
/**
 * Handle health / status / runtime introspection routes.
 * Returns `true` if the request was handled.
 */
export async function handleHealthRoutes(
  ctx: HealthRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, url, state, json, error } = ctx;
  // ── GET /api/status ─────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/status") {
    const effectiveConfig = createDevCloudConfigAuthorityView(state.config);
    const uptime = state.startedAt ? Date.now() - state.startedAt : undefined;
    // The active-model snapshot is optional status info; never let an
    // unavailable local-inference API turn /api/status into a 500. The deep
    // subpath import itself can fail (mobile bundle stub, or a module-resolution
    // environment where the subpath isn't aliased), so guard the import too, not
    // just the snapshot call.
    let activeLocalModel: string | undefined;
    try {
      const { getLocalInferenceActiveSnapshot } =
        await loadLocalInferenceRouteApi();
      const localInferenceActive =
        typeof getLocalInferenceActiveSnapshot === "function"
          ? await getLocalInferenceActiveSnapshot().catch(() => null)
          : null;
      activeLocalModel =
        localInferenceActive?.status === "ready" &&
        localInferenceActive.modelId?.trim()
          ? localInferenceActive.modelId.trim()
          : undefined;
    } catch {
      activeLocalModel = undefined;
    }
    // `state.model` is a boot-time snapshot: it is written once when the
    // runtime starts and never recomputed, so preferring it made /api/status
    // report the provider the agent was configured with at boot rather than
    // the one serving now. Resolve live first and keep the cache only as the
    // fallback for a runtime we can no longer inspect (#20045 review).
    const model =
      detectRuntimeModel(state.runtime ?? null, effectiveConfig) ??
      activeLocalModel ??
      state.model;
    // Managed hosting detection is a pure env check from @elizaos/core and
    // must not depend on loading plugin-elizacloud. Optional hasApiKey still
    // comes from the plugin and degrades to false if the plugin is unloadable
    // — never 500 the status endpoint for optional cloud status fields.
    const cloudProvisioned = isCloudProvisionedContainer();
    let hasCloudApiKey = false;
    try {
      const { resolveCloudApiKey } = await getCloudApiKeyResolver();
      hasCloudApiKey = Boolean(
        resolveCloudApiKey(effectiveConfig, state.runtime),
      );
    } catch {
      // error-policy:J4 optional cloud API-key probe must not fail /api/status
    }
    const cloudStatus = {
      connectionStatus:
        cloudProvisioned || hasCloudApiKey ? "connected" : "disconnected",
      activeAgentId: cloudProvisioned ? state.agentName : null,
      cloudProvisioned,
      hasApiKey: hasCloudApiKey,
    };
    const payload = {
      state: state.agentState,
      agentName: state.agentName,
      model,
      ...(await responseReadinessFields(state.runtime, state.agentState)),
      startedAt: state.startedAt,
      uptime,
      startup: state.startup,
      cloud: cloudStatus,
      pendingRestart: state.pendingRestartReasons.length > 0,
      pendingRestartReasons: state.pendingRestartReasons,
    };
    json(res, ctx.composeStatus ? ctx.composeStatus(payload) : payload);
    return true;
  }
  // ── GET /api/health ──────────────────────────────────────────────────────
  // Structured health check endpoint returning subsystem status.
  if (method === "GET" && pathname === "/api/health") {
    const runtime = state.runtime;
    const uptime = state.startedAt
      ? Math.floor((Date.now() - state.startedAt) / 1000)
      : 0;
    const loadedPluginCount = runtime?.plugins?.length
      ? runtime.plugins.length
      : state.plugins.filter((p) => p.enabled || p.isActive).length;
    const failedPluginCount = state.plugins.filter((p) => p.loadError).length;
    let coordinatorStatus: "ok" | "not_wired" = "not_wired";
    try {
      if (getSwarmCoordinatorService(runtime)) {
        coordinatorStatus = "ok";
      }
    } catch {
      // not available
    }
    const connectors: Record<string, string> = state.connectorHealthMonitor
      ? state.connectorHealthMonitor.getConnectorStatuses()
      : {};
    if (Object.keys(connectors).length === 0 && state.config.connectors) {
      for (const [name, cfg] of Object.entries(state.config.connectors)) {
        if (
          cfg &&
          typeof cfg === "object" &&
          (cfg as Record<string, unknown>).enabled !== false
        ) {
          connectors[name] = "configured";
        }
      }
    }
    const databaseLiveness = await probeRuntimeDatabaseLiveness(runtime);
    const ready =
      state.agentState !== "starting" &&
      state.agentState !== "restarting" &&
      !databaseLiveness.terminal;
    // The endpoint stays unauthenticated for readiness probes, so callers
    // that fail the trusted-local check receive only the liveness bit: the
    // detailed shape discloses deployment topology (connector names, plugin
    // and service counts, database internals, boot phase) to anyone who can
    // reach the port (W1-039). The status code keeps its terminal/ready
    // semantics for orchestrators.
    if (!isTrustedLocalRequest(req)) {
      json(res, { ready }, databaseLiveness.terminal ? 503 : 200);
      return true;
    }
    // Service registration truth (#16309): a service whose start() threw is
    // recorded as "failed" by the runtime but previously never reached this
    // surface, so supervisors saw a settled healthy boot over dead services.
    const serviceHealth = runtime ? runtime.getServiceHealth() : {};
    const failedServiceTypes = Object.entries(serviceHealth)
      .filter(([, entry]) => entry.status === "failed")
      .map(([type]) => type)
      .sort();
    json(
      res,
      {
        ready,
        ...(await responseReadinessFields(runtime, state.agentState)),
        ...(databaseLiveness.terminal ? { canRespond: false } : {}),
        runtime: runtime ? "ok" : "not_initialized",
        database: databaseLiveness.ok
          ? runtime
            ? "ok"
            : "unknown"
          : databaseLiveness.status,
        databaseLiveness,
        plugins: {
          loaded: loadedPluginCount,
          failed: failedPluginCount,
        },
        services: {
          registered: Object.values(serviceHealth).filter(
            (entry) => entry.status === "registered",
          ).length,
          failed: failedServiceTypes.length,
          failedTypes: failedServiceTypes,
        },
        coordinator: coordinatorStatus,
        connectors,
        uptime,
        agentState: state.agentState,
        startup: state.startup,
        // Deferred capabilities (feature routes, connectors, non-essential
        // plugins) register AFTER `ready` flips. Poll `deferredBoot.settled`
        // before hitting feature routes right after boot instead of sleeping.
        deferredBoot: getDeferredBootStatus(),
      },
      databaseLiveness.terminal ? 503 : 200,
    );
    return true;
  }
  // ── GET /api/runtime ───────────────────────────────────────────────────
  // Deep runtime introspection endpoint for advanced debugging UI.
  if (method === "GET" && pathname === "/api/runtime") {
    const maxDepth = parseDebugPositiveInt(
      url.searchParams.get("depth"),
      RUNTIME_DEBUG_DEFAULT_MAX_DEPTH,
      1,
      RUNTIME_DEBUG_MAX_DEPTH_CAP,
    );
    const maxArrayLength = parseDebugPositiveInt(
      url.searchParams.get("maxArrayLength"),
      RUNTIME_DEBUG_DEFAULT_MAX_ARRAY_LENGTH,
      1,
      5000,
    );
    const maxObjectEntries = parseDebugPositiveInt(
      url.searchParams.get("maxObjectEntries"),
      RUNTIME_DEBUG_DEFAULT_MAX_OBJECT_ENTRIES,
      1,
      5000,
    );
    const maxStringLength = parseDebugPositiveInt(
      url.searchParams.get("maxStringLength"),
      RUNTIME_DEBUG_DEFAULT_MAX_STRING_LENGTH,
      64,
      100000,
    );
    if (
      maxDepth === "invalid" ||
      maxArrayLength === "invalid" ||
      maxObjectEntries === "invalid" ||
      maxStringLength === "invalid"
    ) {
      error(
        res,
        "depth, maxArrayLength, maxObjectEntries, and maxStringLength must be canonical positive integers",
        400,
      );
      return true;
    }
    const serializeOptions: RuntimeDebugSerializeOptions = {
      maxDepth,
      maxArrayLength,
      maxObjectEntries,
      maxStringLength,
    };
    const runtime = state.runtime;
    const generatedAt = Date.now();
    if (!runtime) {
      json(res, {
        runtimeAvailable: false,
        generatedAt,
        settings: serializeOptions,
        meta: {
          agentState: state.agentState,
          agentName: state.agentName,
          model: state.model ?? null,
          pluginCount: 0,
          actionCount: 0,
          providerCount: 0,
          evaluatorCount: 0,
          serviceTypeCount: 0,
          serviceCount: 0,
        },
        order: {
          plugins: [],
          actions: [],
          providers: [],
          evaluators: [],
          services: [],
        },
        sections: {
          runtime: null,
          plugins: [],
          actions: [],
          providers: [],
          evaluators: [],
          services: {},
        },
      });
      return true;
    }
    try {
      const payload = getCachedRuntimeDebugSnapshot(
        runtime,
        serializeOptions,
        () => {
          const servicesMap = runtime.services as Map<string, unknown[]>;
          const serviceCount = Array.from(servicesMap.values()).reduce(
            (sum, entries) =>
              sum + (Array.isArray(entries) ? entries.length : 0),
            0,
          );
          const orderServices = describeRuntimeServiceOrder(servicesMap);
          const orderPlugins = describeRuntimeOrder(runtime.plugins, "plugin");
          const orderActions = describeRuntimeOrder(runtime.actions, "action");
          const orderProviders = describeRuntimeOrder(
            runtime.providers,
            "provider",
          );
          const orderEvaluators = describeRuntimeOrder(
            runtime.evaluators,
            "evaluator",
          );
          return {
            runtimeAvailable: true,
            generatedAt,
            settings: serializeOptions,
            meta: {
              agentId: runtime.agentId,
              agentState: state.agentState,
              agentName: runtime.character.name ?? state.agentName,
              model: state.model ?? null,
              pluginCount: runtime.plugins.length,
              actionCount: runtime.actions.length,
              providerCount: runtime.providers.length,
              evaluatorCount: runtime.evaluators.length,
              serviceTypeCount: servicesMap.size,
              serviceCount,
            },
            order: {
              plugins: orderPlugins,
              actions: orderActions,
              providers: orderProviders,
              evaluators: orderEvaluators,
              services: orderServices,
            },
            sections: {
              runtime: serializeForRuntimeDebug(runtime, serializeOptions),
              plugins: serializeForRuntimeDebug(
                runtime.plugins,
                serializeOptions,
              ),
              actions: serializeForRuntimeDebug(
                runtime.actions,
                serializeOptions,
              ),
              providers: serializeForRuntimeDebug(
                runtime.providers,
                serializeOptions,
              ),
              evaluators: serializeForRuntimeDebug(
                runtime.evaluators,
                serializeOptions,
              ),
              services: serializeForRuntimeDebug(servicesMap, serializeOptions),
            },
          };
        },
      );
      json(res, payload);
    } catch (err) {
      error(
        res,
        `Failed to build runtime debug snapshot: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }
  return false;
}
