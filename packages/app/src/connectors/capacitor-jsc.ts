/**
 * Native boundary contract for the `CapacitorJsc` Capacitor plugin: declares the
 * marshalled-value wire format and the native method surface, then registers a
 * `jsc-ios` factory with `@elizaos/agent`'s JS-runtime registry so the agent can
 * evaluate/import untrusted JS on iOS. The Swift class (target name
 * `CapacitorJscPlugin`, registered with `@objc(CapacitorJscPlugin)`) must
 * implement the methods declared on `CapacitorJscPlugin` below. Uses a host
 * JSContext (JavaScriptCore), not a WKWebView, so App Review treats the runtime
 * as a sandboxed scripting engine.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

import {
  type JsRuntimeEvaluateOptions as CapacitorJscEvaluateOptions,
  type JsRuntimeImportOptions as CapacitorJscImportOptions,
  type JsRuntimeBridge,
  type JsValue,
  registerJsRuntimeFactory,
} from "@elizaos/agent";

/**
 * Wire-format for marshalled JS values shared with `@elizaos/agent`'s
 * `JsRuntimeBridge`. Re-exported so callers that only depend on this connector
 * don't need to import `@elizaos/agent` for the type alone.
 */
export type { CapacitorJscEvaluateOptions, CapacitorJscImportOptions, JsValue };

/**
 * Native API surface the Swift implementation must expose. The Capacitor
 * plugin bridge maps each method to an `@objc` selector of the same name,
 * called with the option object as the single `CAPPluginCall`.
 */
export interface CapacitorJscPlugin {
  /**
   * Evaluate `code` in a fresh JSContext. Returns the last-expression value
   * marshalled into the {@link JsValue} wire format. Reject the call with
   * `Error("timeout")` when `timeoutMs` elapses.
   */
  evaluate(options: CapacitorJscEvaluateOptions): Promise<{ value: JsValue }>;

  /**
   * Load and evaluate the module at `absolutePath` (which must already exist
   * on the device, e.g. unpacked from app bundle). Return the module's
   * exports object marshalled into the {@link JsValue} wire format.
   */
  importModule(
    options: CapacitorJscImportOptions,
  ): Promise<{ exports: JsValue }>;

  /** Tear down the JSContext and release any retained references. */
  dispose(): Promise<void>;
}

export const CapacitorJsc = registerPlugin<CapacitorJscPlugin>("CapacitorJsc");

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

function isJscPluginAvailable(): boolean {
  const cap = getCapacitorHost();
  return (
    cap.isNativePlatform?.() === true &&
    cap.getPlatform?.() === "ios" &&
    cap.isPluginAvailable?.("CapacitorJsc") === true
  );
}

class CapacitorJscBridge implements JsRuntimeBridge {
  readonly kind = "jsc-ios" as const;
  constructor(private readonly plugin: CapacitorJscPlugin) {}
  async evaluate(opts: CapacitorJscEvaluateOptions): Promise<JsValue> {
    const result = await this.plugin.evaluate(opts);
    return result.value;
  }
  async importModule(
    opts: CapacitorJscImportOptions,
  ): Promise<{ exports: JsValue }> {
    return this.plugin.importModule(opts);
  }
  async dispose(): Promise<void> {
    await this.plugin.dispose();
  }
}

registerJsRuntimeFactory({
  kind: "jsc-ios",
  async create() {
    if (!isJscPluginAvailable()) {
      return null;
    }
    return new CapacitorJscBridge(CapacitorJsc);
  },
});
