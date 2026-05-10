// TODO(native): Swift implementation pending — this file is the TS-side
// facade for the eventual `CapacitorJsc` Capacitor plugin. The Swift class
// (target name: `CapacitorJscPlugin`, registered with
// `@objc(CapacitorJscPlugin)`) must implement the methods declared on
// `CapacitorJscPlugin` below. Use a host JSContext (JavaScriptCore) — NOT a
// WKWebView — so App Review treats the runtime as a sandboxed scripting
// engine, not a browser.

import { registerPlugin } from "@capacitor/core";

import {
  type JsRuntimeBridge,
  type JsValue as AgentJsValue,
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

export interface CapacitorJscEvaluateOptions {
  code: string;
  sourceUrl?: string;
  timeoutMs?: number;
}

export interface CapacitorJscImportOptions {
  /** Absolute path on the device filesystem. */
  absolutePath: string;
  /** Optional ESM-style specifier (file URL by default). */
  specifier?: string;
}

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
  evaluate(
    options: CapacitorJscEvaluateOptions,
  ): Promise<{ value: JsValue }>;

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

class CapacitorJscBridge implements JsRuntimeBridge {
  readonly kind = "jsc-ios" as const;
  constructor(private readonly plugin: CapacitorJscPlugin) {}
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
  kind: "jsc-ios",
  async create() {
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
    if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== "ios") {
      return null;
    }
    return new CapacitorJscBridge(CapacitorJsc);
  },
});
