/**
 * Native boundary contract for the `CapacitorQuickJs` Capacitor plugin: declares
 * the marshalled-value wire format and the native method surface, then registers
 * the `quickjs-android` and `quickjs-ios-fallback` factories with
 * `@elizaos/agent`'s JS-runtime registry. Android is the primary target: the
 * Kotlin plugin must run QuickJS in a service with
 * `android:isolatedProcess="true"` so interpreter faults and untrusted code stay
 * outside the host process. iOS registers the same plugin only as the fallback
 * runtime when JavaScriptCore is unavailable.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

import {
  type JsRuntimeEvaluateOptions as CapacitorQuickJsEvaluateOptions,
  type JsRuntimeImportOptions as CapacitorQuickJsImportOptions,
  type JsRuntimeBridge,
  type JsRuntimeKind,
  type JsValue,
  registerJsRuntimeFactory,
} from "@elizaos/agent";

/**
 * Wire-format for marshalled JS values shared with `@elizaos/agent`'s
 * `JsRuntimeBridge`. Re-exported so callers that only depend on this connector
 * don't need to import `@elizaos/agent` for the type alone.
 */
export type {
  CapacitorQuickJsEvaluateOptions,
  CapacitorQuickJsImportOptions,
  JsValue,
};

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
  async evaluate(opts: CapacitorQuickJsEvaluateOptions): Promise<JsValue> {
    const result = await this.plugin.evaluate(opts);
    return result.value;
  }
  async importModule(
    opts: CapacitorQuickJsImportOptions,
  ): Promise<{ exports: JsValue }> {
    return this.plugin.importModule(opts);
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
