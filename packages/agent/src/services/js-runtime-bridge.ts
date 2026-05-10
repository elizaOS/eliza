/**
 * JS Runtime Bridge
 *
 * Shared TypeScript contract for executing plugin JavaScript across the
 * different host runtimes Eliza targets:
 *
 *   - Node / Bun  → host-node bridge using `node:vm` sandboxes.
 *   - iOS native  → JavaScriptCore (JSC) inside a host JSContext via the
 *                   `CapacitorJsc` Capacitor plugin (Swift). NOT WKWebView —
 *                   Apple App Review treats arbitrary remote JS in WKWebView
 *                   as a non-starter; an embedded JSContext is acceptable.
 *   - Android     → QuickJS in an `android:isolatedProcess=true` service
 *                   exposed by the `CapacitorQuickJs` plugin (Kotlin).
 *   - iOS fallback → QuickJS via the same CapacitorQuickJs plugin if JSC is
 *                   unavailable for any reason.
 *
 * The runtime resolver picks one of these implementations and the rest of the
 * agent talks to it through the {@link JsRuntimeBridge} interface — no
 * runtime-type branching at call sites.
 */

import type { Context as VmContext, Script as VmScript } from "node:vm";

/** Identifier for which concrete bridge implementation is running. */
export type JsRuntimeKind =
  | "host-node"
  | "jsc-ios"
  | "quickjs-android"
  | "quickjs-ios-fallback";

/**
 * Marshalled JS value. Functions are returned as opaque {@link JsValue.functionId}
 * handles so the host can re-invoke them without leaking native references
 * back into Eliza.
 */
export type JsValue =
  | { kind: "undefined" }
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "object"; entries: Array<[string, JsValue]> }
  | { kind: "array"; items: JsValue[] }
  | { kind: "function"; functionId: string };

export interface JsRuntimeEvaluateOptions {
  /** Source code to evaluate. The result of the last expression is returned. */
  code: string;
  /** Optional source URL used for stack traces. */
  sourceUrl?: string;
  /** Wall-clock timeout in milliseconds. */
  timeoutMs?: number;
}

export interface JsRuntimeImportOptions {
  /** Absolute path to the module file. */
  absolutePath: string;
  /** Optional ESM specifier override (defaults to file URL of `absolutePath`). */
  specifier?: string;
}

export interface JsRuntimeBridge {
  readonly kind: JsRuntimeKind;
  evaluate(opts: JsRuntimeEvaluateOptions): Promise<JsValue>;
  importModule(
    opts: JsRuntimeImportOptions,
  ): Promise<{ exports: JsValue }>;
  dispose(): Promise<void>;
}

/* ── Marshalling ────────────────────────────────────────────────────────── */

interface MarshalContext {
  functionTable: Map<string, (...args: unknown[]) => unknown>;
  nextFunctionId: number;
}

function newMarshalContext(): MarshalContext {
  return { functionTable: new Map(), nextFunctionId: 0 };
}

const MAX_MARSHAL_DEPTH = 32;

/**
 * Convert a host JS value into the wire {@link JsValue} shape. Cycles, BigInts,
 * Symbols, Dates, and class instances collapse to a plain object/string view —
 * the bridge contract is intentionally narrow so the iOS/Android sides have a
 * minimal surface to implement.
 */
export function toJsValue(input: unknown, ctx?: MarshalContext): JsValue {
  const c = ctx ?? newMarshalContext();
  return marshalValue(input, c, 0, new WeakSet());
}

function marshalValue(
  input: unknown,
  ctx: MarshalContext,
  depth: number,
  seen: WeakSet<object>,
): JsValue {
  if (depth > MAX_MARSHAL_DEPTH) {
    return { kind: "string", value: "[depth-limit]" };
  }
  if (input === undefined) return { kind: "undefined" };
  if (input === null) return { kind: "null" };

  const t = typeof input;
  if (t === "boolean") return { kind: "boolean", value: input as boolean };
  if (t === "number") {
    const n = input as number;
    return { kind: "number", value: Number.isFinite(n) ? n : 0 };
  }
  if (t === "string") return { kind: "string", value: input as string };
  if (t === "bigint") return { kind: "string", value: (input as bigint).toString() };
  if (t === "symbol") return { kind: "string", value: (input as symbol).toString() };

  if (t === "function") {
    const id = `fn:${ctx.nextFunctionId++}`;
    ctx.functionTable.set(id, input as (...args: unknown[]) => unknown);
    return { kind: "function", functionId: id };
  }

  if (Array.isArray(input)) {
    if (seen.has(input)) return { kind: "string", value: "[cycle]" };
    seen.add(input);
    return {
      kind: "array",
      items: input.map((item) => marshalValue(item, ctx, depth + 1, seen)),
    };
  }

  if (t === "object") {
    const obj = input as Record<string, unknown>;
    if (seen.has(obj)) return { kind: "string", value: "[cycle]" };
    seen.add(obj);
    const entries: Array<[string, JsValue]> = [];
    for (const key of Object.keys(obj)) {
      entries.push([key, marshalValue(obj[key], ctx, depth + 1, seen)]);
    }
    return { kind: "object", entries };
  }

  return { kind: "undefined" };
}

/* ── Distribution profile (local fallback) ──────────────────────────────── */

/**
 * Local fallback for the broker-track distribution profile. Once
 * `@elizaos/shared/distribution-profile` lands, this resolver should defer to
 * it. Until then the env hook below is the source of truth.
 */
type DistributionProfile = "appstore" | "sideload" | "dev";

function resolveDistributionProfileLocal(): DistributionProfile {
  const raw =
    typeof process !== "undefined"
      ? (process.env?.MILADY_DISTRIBUTION_PROFILE ??
        process.env?.ELIZA_DISTRIBUTION_PROFILE ??
        "")
      : "";
  switch (raw.trim().toLowerCase()) {
    case "appstore":
      return "appstore";
    case "sideload":
      return "sideload";
    case "dev":
      return "dev";
    default:
      return "appstore";
  }
}

/* ── host-node implementation ──────────────────────────────────────────── */

interface HostNodeVm {
  Script: typeof VmScript;
  createContext(sandbox?: object): VmContext;
  runInContext(code: string, ctx: VmContext, opts?: { timeout?: number; filename?: string }): unknown;
}

class HostNodeBridge implements JsRuntimeBridge {
  readonly kind: JsRuntimeKind = "host-node";
  private vmModule: HostNodeVm | null = null;
  private disposed = false;

  private async loadVm(): Promise<HostNodeVm> {
    if (!this.vmModule) {
      const mod = (await import("node:vm")) as unknown as HostNodeVm;
      this.vmModule = mod;
    }
    return this.vmModule;
  }

  async evaluate(opts: JsRuntimeEvaluateOptions): Promise<JsValue> {
    if (this.disposed) {
      throw new Error("[js-runtime-bridge] bridge has been disposed");
    }
    const vm = await this.loadVm();
    const sandbox: Record<string, unknown> = Object.create(null);
    const context = vm.createContext(sandbox);
    const filename = opts.sourceUrl ?? "eliza-evaluate";
    const timeout = opts.timeoutMs ?? 30_000;
    const script = new vm.Script(opts.code, { filename });
    const result = script.runInContext(context, { timeout });
    if (result instanceof Promise) {
      return toJsValue(await result);
    }
    return toJsValue(result);
  }

  async importModule(
    opts: JsRuntimeImportOptions,
  ): Promise<{ exports: JsValue }> {
    if (this.disposed) {
      throw new Error("[js-runtime-bridge] bridge has been disposed");
    }
    const specifier = opts.specifier ?? toFileUrl(opts.absolutePath);
    const mod = (await import(specifier)) as Record<string, unknown>;
    return { exports: toJsValue(mod) };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.vmModule = null;
  }
}

function toFileUrl(absolutePath: string): string {
  if (/^[a-z]+:\/\//i.test(absolutePath)) {
    return absolutePath;
  }
  if (absolutePath.startsWith("/")) {
    return `file://${absolutePath}`;
  }
  return absolutePath;
}

/* ── Capacitor plugin registration ─────────────────────────────────────── */

/**
 * Capacitor plugin facades register themselves through this hook so the
 * agent layer never has to import the connector layer directly (the
 * dependency direction is connector → agent, not the other way around).
 *
 * `packages/app-core/src/connectors/capacitor-jsc.ts` and
 * `packages/app-core/src/connectors/capacitor-quickjs.ts` call
 * {@link registerJsRuntimeFactory} at import time so they participate in the
 * fallback chain below.
 */
export interface JsRuntimeFactory {
  /** Stable identifier used to pick a factory in {@link resolveJsRuntimeBridge}. */
  readonly kind: Exclude<JsRuntimeKind, "host-node">;
  /** Returns a ready bridge, or null if the underlying plugin isn't present. */
  create(): Promise<JsRuntimeBridge | null>;
}

const registeredFactories: JsRuntimeFactory[] = [];

export function registerJsRuntimeFactory(factory: JsRuntimeFactory): void {
  if (registeredFactories.some((existing) => existing.kind === factory.kind)) {
    return;
  }
  registeredFactories.push(factory);
}

/* ── Resolver ──────────────────────────────────────────────────────────── */

function isNodeLikeRuntime(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions === "object" &&
    process.versions !== null &&
    typeof process.versions.node === "string"
  );
}

function detectCapacitorPlatform(): "ios" | "android" | "web" | "unknown" {
  const cap = (globalThis as { Capacitor?: { getPlatform?: () => string } })
    .Capacitor;
  const platform = cap?.getPlatform?.();
  if (platform === "ios" || platform === "android" || platform === "web") {
    return platform;
  }
  return "unknown";
}

async function tryFactory(
  kind: JsRuntimeFactory["kind"],
): Promise<JsRuntimeBridge | null> {
  const factory = registeredFactories.find((f) => f.kind === kind);
  if (!factory) return null;
  return factory.create();
}

let cachedBridge: JsRuntimeBridge | null = null;

export async function resolveJsRuntimeBridge(): Promise<JsRuntimeBridge> {
  if (cachedBridge) return cachedBridge;

  // Distribution profile is queried so future logic can lock down dev-only
  // bridges (e.g. host-node import of arbitrary file paths) on App Store
  // builds. Currently informational only.
  resolveDistributionProfileLocal();

  if (isNodeLikeRuntime()) {
    cachedBridge = new HostNodeBridge();
    return cachedBridge;
  }

  const platform = detectCapacitorPlatform();

  if (platform === "ios") {
    const jsc = await tryFactory("jsc-ios");
    if (jsc) {
      cachedBridge = jsc;
      return cachedBridge;
    }
    const fallback = await tryFactory("quickjs-ios-fallback");
    if (fallback) {
      cachedBridge = fallback;
      return cachedBridge;
    }
  }

  if (platform === "android") {
    const quickjs = await tryFactory("quickjs-android");
    if (quickjs) {
      cachedBridge = quickjs;
      return cachedBridge;
    }
  }

  // Web / unknown: try every registered factory, in registration order.
  for (const factory of registeredFactories) {
    const bridge = await factory.create();
    if (bridge) {
      cachedBridge = bridge;
      return cachedBridge;
    }
  }

  throw new Error(
    `[js-runtime-bridge] no JS runtime available (platform=${platform})`,
  );
}

/** Test-only hook to clear the cached bridge and factory registry. */
export function __resetJsRuntimeBridgeForTests(): void {
  cachedBridge = null;
  registeredFactories.splice(0, registeredFactories.length);
}
