import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import {
  isCloudProvisionedContainer,
  resolveCloudApiKey,
} from "@elizaos/plugin-elizacloud";
import { getLocalInferenceActiveSnapshot } from "@elizaos/plugin-local-inference";
import type { ElizaConfig } from "../config/config.ts";
import type { ConnectorHealthMonitor } from "./connector-health.ts";

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

export interface HealthRouteContext {
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

function parseDebugPositiveInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const intValue = Math.floor(parsed);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function classNameFor(value: object): string {
  const ctor = (value as { constructor?: { name?: string } }).constructor;
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

function serializeForRuntimeDebug(
  value: unknown,
  options: RuntimeDebugSerializeOptions,
): unknown {
  const seen = new WeakMap<object, string>();

  const visit = (current: unknown, path: string, depth: number): unknown => {
    if (current === null) return null;

    const kind = typeof current;

    if (kind === "string") {
      if ((current as string).length <= options.maxStringLength) return current;
      return {
        __type: "string",
        length: (current as string).length,
        preview: `${(current as string).slice(0, options.maxStringLength)}...`,
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
      const err = obj as Error & { cause?: unknown };
      const out: Record<string, unknown> = {
        __type: "error",
        name: err.name,
        message: err.message,
      };
      if (err.stack) {
        out.stack =
          err.stack.length > options.maxStringLength
            ? `${err.stack.slice(0, options.maxStringLength)}...`
            : err.stack;
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
      const entries: Array<{ key: unknown; value: unknown }> = [];
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
 * Handle health / status / runtime introspection routes.
 * Returns `true` if the request was handled.
 */
export async function handleHealthRoutes(
  ctx: HealthRouteContext,
): Promise<boolean> {
  const { res, method, pathname, url, state, json, error } = ctx;

  // ── GET /api/status ─────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/status") {
    const uptime = state.startedAt ? Date.now() - state.startedAt : undefined;
    const localInferenceActive = await getLocalInferenceActiveSnapshot().catch(
      () => null,
    );
    const activeLocalModel =
      localInferenceActive?.status === "ready" &&
      localInferenceActive.modelId?.trim()
        ? localInferenceActive.modelId.trim()
        : undefined;
    const model = state.model ?? activeLocalModel;
    const cloudProvisioned = isCloudProvisionedContainer();
    const hasCloudApiKey = Boolean(
      resolveCloudApiKey(state.config, state.runtime),
    );
    const cloudStatus = {
      connectionStatus:
        cloudProvisioned || hasCloudApiKey ? "connected" : "disconnected",
      activeAgentId: cloudProvisioned ? state.agentName : null,
      cloudProvisioned,
      hasApiKey: hasCloudApiKey,
    };

    json(res, {
      state: state.agentState,
      agentName: state.agentName,
      model,
      startedAt: state.startedAt,
      uptime,
      startup: state.startup,
      cloud: cloudStatus,
      pendingRestart: state.pendingRestartReasons.length > 0,
      pendingRestartReasons: state.pendingRestartReasons,
    });
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
      if (runtime?.getService("SWARM_COORDINATOR")) {
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

    const ready =
      state.agentState !== "starting" && state.agentState !== "restarting";

    json(res, {
      ready,
      runtime: runtime ? "ok" : "not_initialized",
      database: runtime ? "ok" : "unknown",
      plugins: {
        loaded: loadedPluginCount,
        failed: failedPluginCount,
      },
      coordinator: coordinatorStatus,
      connectors,
      uptime,
      agentState: state.agentState,
      startup: state.startup,
    });
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
      100_000,
    );

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
          serviceTypeCount: 0,
          serviceCount: 0,
        },
        order: {
          plugins: [],
          actions: [],
          providers: [],
          services: [],
        },
        sections: {
          runtime: null,
          plugins: [],
          actions: [],
          providers: [],
          services: {},
        },
      });
      return true;
    }

    try {
      const servicesMap = runtime.services as Map<string, unknown[]>;
      const serviceCount = Array.from(servicesMap.values()).reduce(
        (sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0),
        0,
      );
      const orderServices = describeRuntimeServiceOrder(servicesMap);
      const orderPlugins = describeRuntimeOrder(runtime.plugins, "plugin");
      const orderActions = describeRuntimeOrder(runtime.actions, "action");
      const orderProviders = describeRuntimeOrder(
        runtime.providers,
        "provider",
      );

      json(res, {
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
          serviceTypeCount: servicesMap.size,
          serviceCount,
        },
        order: {
          plugins: orderPlugins,
          actions: orderActions,
          providers: orderProviders,
          services: orderServices,
        },
        sections: {
          runtime: serializeForRuntimeDebug(runtime, serializeOptions),
          plugins: serializeForRuntimeDebug(runtime.plugins, serializeOptions),
          actions: serializeForRuntimeDebug(runtime.actions, serializeOptions),
          providers: serializeForRuntimeDebug(
            runtime.providers,
            serializeOptions,
          ),
          services: serializeForRuntimeDebug(servicesMap, serializeOptions),
        },
      });
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
