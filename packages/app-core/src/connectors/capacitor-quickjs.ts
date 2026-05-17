// Native boundary contract for the `CapacitorQuickJs` Capacitor plugin.
// Android is the primary target: the Kotlin plugin must run QuickJS in a
// service with `android:isolatedProcess="true"` so interpreter faults and
// untrusted code stay outside the host process. iOS may register the same
// plugin only as the fallback runtime when JavaScriptCore is unavailable.

import { Capacitor, registerPlugin } from "@capacitor/core";

import {
  type JsValue as AgentJsValue,
  type JsRuntimeBridge,
  type JsRuntimeKind,
  registerJsRuntimeFactory,
} from "@elizaos/agent";

/**
 * Wire-format for marshalled JS values shared with `@elizaos/agent`'s
 * `JsRuntimeBridge`. Re-exported so callers that only depend on this connector
 * don't need to import `@elizaos/agent` for the type alone.
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

export interface CapacitorQuickJsEvaluateOptions {
  code: string;
  sourceUrl?: string;
  timeoutMs?: number;
}

export interface CapacitorQuickJsImportOptions {
  absolutePath: string;
  specifier?: string;
}

/**
 * Native API surface the Kotlin / Swift implementation must expose. On
 * Android, the plugin must dispatch each call across the AIDL boundary into
 * the isolated-process service that owns the QuickJS interpreter.
 */
export interface CapacitorQuickJsPlugin {
  /**
   * Evaluate `code` in a fresh QuickJS context. Returns the last-expression
   * value marshalled into the {@link JsValue} wire format. Reject the call
   * with `Error("timeout")` when `timeoutMs` elapses.
   */
  evaluate(
    options: CapacitorQuickJsEvaluateOptions,
  ): Promise<{ value: JsValue }>;

  /**
   * Load and evaluate the module at `absolutePath` (which must already exist
   * on the device). Return the module's exports object marshalled into the
   * {@link JsValue} wire format.
   */
  importModule(
    options: CapacitorQuickJsImportOptions,
  ): Promise<{ exports: JsValue }>;

  /** Tear down the QuickJS context and release any retained references. */
  dispose(): Promise<void>;
}

export const CapacitorQuickJs =
  registerPlugin<CapacitorQuickJsPlugin>("CapacitorQuickJs");

/* ── Bridge adapter registration ───────────────────────────────────────── */

interface CapacitorHost {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
}

function getCapacitorHost(): CapacitorHost {
  return (
    (globalThis as { Capacitor?: CapacitorHost }).Capacitor ??
    (Capacitor as CapacitorHost)
  );
}

function isQuickJsPluginAvailable(platform: "android" | "ios"): boolean {
  const cap = getCapacitorHost();
  return (
    cap.isNativePlatform?.() === true &&
    cap.getPlatform?.() === platform &&
    cap.isPluginAvailable?.("CapacitorQuickJs") === true
  );
}

class CapacitorQuickJsBridge implements JsRuntimeBridge {
  constructor(
    private readonly plugin: CapacitorQuickJsPlugin,
    public readonly kind: Extract<
      JsRuntimeKind,
      "quickjs-android" | "quickjs-ios-fallback"
    >,
  ) {}
  async evaluate(opts: {
    code: string;
    sourceUrl?: string;
    timeoutMs?: number;
  }): Promise<AgentJsValue> {
    const result = await this.plugin.evaluate(opts);
    return result.value as AgentJsValue;
  }
  async importModule(opts: {
    absolutePath: string;
    specifier?: string;
  }): Promise<{ exports: AgentJsValue }> {
    const result = await this.plugin.importModule(opts);
    return { exports: result.exports as AgentJsValue };
  }
  async dispose(): Promise<void> {
    await this.plugin.dispose();
  }
}

registerJsRuntimeFactory({
  kind: "quickjs-android",
  async create() {
    if (!isQuickJsPluginAvailable("android")) {
      return null;
    }
    return new CapacitorQuickJsBridge(CapacitorQuickJs, "quickjs-android");
  },
});

registerJsRuntimeFactory({
  kind: "quickjs-ios-fallback",
  async create() {
    if (!isQuickJsPluginAvailable("ios")) {
      return null;
    }
    return new CapacitorQuickJsBridge(CapacitorQuickJs, "quickjs-ios-fallback");
  },
});
