/**
 * iOS streaming-LLM adapter.
 *
 * Mirror of the AOSP plugin's `aosp-llama-streaming.ts` for the iOS
 * platform.  Bridges the JS-side streaming surface (the same shape the
 * `FfiStreamingRunner` expects) over the `LlamaCpp.xcframework` Swift
 * bridge that ships with the iOS shell.
 *
 * Status (2026-05-12): the XCFramework currently ships as a shim — it
 * compiles a header-only `llama.h` and exports a `dlopen`-safe stub for
 * the bridge.  The real Swift implementation against
 * `libelizainference.dylib` (built by `build-llama-cpp-dflash.mjs` with
 * the `darwin-arm64-metal-fused` target) is the gating item; until then
 * `loadIosStreamingLlmBinding` returns `null` and the runtime falls
 * back to the cloud route.
 *
 * Why XCFramework + Swift bridge rather than `bun:ffi` directly:
 *   - bun:ffi runs only inside the Bun runtime.  On iOS, Eliza ships the
 *     ElizaBunEngine.xcframework which embeds a Bun runtime — but the
 *     llama symbols cannot be resolved at `bun:ffi.dlopen` time on a
 *     codesigned device build (the dynamic linker forbids loading
 *     arbitrary `.dylib` from the app bundle on a real device).
 *   - The Swift bridge wraps the symbols at compile time inside the
 *     XCFramework so the codesignature covers them.  Capacitor's
 *     `llama-cpp-capacitor` plugin already uses this pattern for the
 *     non-streaming surface.
 *
 * The Swift glue (NOT in this repo yet — gating item) needs to:
 *   1. Re-export the streaming-LLM symbols from `ffi-streaming-llm.h`
 *      under the Swift module name `LlamaCpp.Streaming.*`.
 *   2. Expose an Objective-C-bridgeable wrapper class
 *      (`LlamaStreamingSession`) so Capacitor's plugin can register
 *      methods on it.
 *   3. Wire `ProcessInfo.thermalState` into a thermal-throttle hook so
 *      iOS can bail out of speculative decoding under sustained heat.
 *
 * Until that lands, this file:
 *   - declares the JS contract,
 *   - probes for `(window as any).LlamaStreaming` (the Capacitor plugin
 *     entry point Swift will expose),
 *   - logs + returns null when the bridge isn't there.
 */

import { logger } from "@elizaos/core";

/* -------------------------------------------------------------------- */
/* Public types — identical shape to the AOSP binding so the runner     */
/* doesn't know or care which platform it's on.                         */
/* -------------------------------------------------------------------- */

export type IosLlmStreamHandle = bigint;
export type IosInferenceContextHandle = bigint;

export interface IosLlmStreamConfig {
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  slotId: number;
  promptCacheKey: string | null;
  draftMin: number;
  draftMax: number;
  dflashDrafterPath: string | null;
  disableThinking: boolean;
}

export interface IosLlmStreamStep {
  tokens: number[];
  text: string;
  done: boolean;
  drafterDrafted: number;
  drafterAccepted: number;
}

export interface IosStreamingLlmBinding {
  llmStreamSupported(): boolean;
  llmStreamOpen(args: {
    ctx: IosInferenceContextHandle;
    config: IosLlmStreamConfig;
  }): IosLlmStreamHandle;
  llmStreamPrefill(args: {
    stream: IosLlmStreamHandle;
    tokens: Int32Array;
  }): void;
  llmStreamNext(args: {
    stream: IosLlmStreamHandle;
    maxTokensPerStep?: number;
    maxTextBytes?: number;
  }): IosLlmStreamStep;
  llmStreamCancel(stream: IosLlmStreamHandle): void;
  llmStreamSaveSlot(args: {
    stream: IosLlmStreamHandle;
    filename: string;
  }): void;
  llmStreamRestoreSlot(args: {
    stream: IosLlmStreamHandle;
    filename: string;
  }): void;
  llmStreamClose(stream: IosLlmStreamHandle): void;
}

/* -------------------------------------------------------------------- */
/* Capacitor bridge contract                                            */
/*                                                                      */
/* Shape the Swift side must expose.  Capacitor exposes plugin methods  */
/* via `window.Capacitor.Plugins.LlamaStreaming` once the bridge is     */
/* registered.  Each method is a Promise on the JS side (Capacitor      */
/* serialises across the JS↔native bridge), so the synchronous          */
/* `IosStreamingLlmBinding` shape is built by `loadIosStreamingLlmBinding`*/
/* over a small adapter — but the underlying bridge is async.           */
/* -------------------------------------------------------------------- */

interface CapacitorLlamaStreamingPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  open(args: {
    ctxHandle: string; // bigint serialised as string over the bridge
    config: IosLlmStreamConfig;
  }): Promise<{ streamHandle: string }>;
  prefill(args: { streamHandle: string; tokens: number[] }): Promise<void>;
  /**
   * Iteration is event-based on the native side — Capacitor plugin
   * `addListener("llmStreamStep", cb)` fires for each step.  The JS
   * binding shape we want is synchronous-ish for symmetry with bun:ffi;
   * the adapter in `buildIosBinding` (TODO when the Swift bridge ships)
   * will turn the listener stream into a `next()`-like queue.
   */
  cancel(args: { streamHandle: string }): Promise<void>;
  saveSlot(args: { streamHandle: string; filename: string }): Promise<void>;
  restoreSlot(args: { streamHandle: string; filename: string }): Promise<void>;
  close(args: { streamHandle: string }): Promise<void>;
}

interface CapacitorWindow {
  Capacitor?: {
    Plugins?: {
      LlamaStreaming?: CapacitorLlamaStreamingPlugin;
    };
    isNativePlatform?(): boolean;
    getPlatform?(): string;
  };
}

function tryGetCapacitorPlugin(): CapacitorLlamaStreamingPlugin | null {
  const w = globalThis as unknown as CapacitorWindow;
  const plugin = w.Capacitor?.Plugins?.LlamaStreaming;
  if (!plugin) return null;
  if (
    typeof plugin.open !== "function" ||
    typeof plugin.prefill !== "function" ||
    typeof plugin.cancel !== "function" ||
    typeof plugin.close !== "function"
  ) {
    return null;
  }
  return plugin;
}

/* -------------------------------------------------------------------- */
/* Loader                                                               */
/* -------------------------------------------------------------------- */

/**
 * Try to load the iOS streaming-LLM binding.  Returns null when:
 *   - we are not on iOS,
 *   - the Capacitor `LlamaStreaming` plugin isn't registered,
 *   - the bridge reports `isAvailable() === false` (e.g. the XCFramework
 *     was built without streaming-LLM support).
 *
 * Returning null is NOT a failure — the runtime then falls back to the
 * cloud route.  Throws only when the bridge is present but
 * mis-configured (probe-and-catch is reserved for the boot path).
 */
export async function loadIosStreamingLlmBinding(): Promise<IosStreamingLlmBinding | null> {
  const plugin = tryGetCapacitorPlugin();
  if (!plugin) {
    logger.info(
      "[ios-llama-streaming] No Capacitor LlamaStreaming plugin registered. " +
        "iOS streaming-LLM unavailable.",
    );
    return null;
  }
  const probe = await plugin.isAvailable().catch((err: unknown) => {
    logger.warn(
      `[ios-llama-streaming] isAvailable probe threw: ${formatError(err)}`,
    );
    return { available: false };
  });
  if (!probe.available) {
    logger.info(
      "[ios-llama-streaming] LlamaCpp.xcframework reports streaming-LLM " +
        "unsupported (shim build).  See docs/eliza-1-ios-streaming-status.md.",
    );
    return null;
  }
  return buildIosBinding(plugin);
}

/**
 * Wrap the async Capacitor plugin in the synchronous-ish JS contract
 * `FfiStreamingRunner` expects.  Internally this means buffering
 * `llmStreamStep` events from the Capacitor listener bus into a JS
 * queue keyed by stream handle, then having `llmStreamNext` block on a
 * `Promise<step>`.
 *
 * THIS IS A STUB.  Until the Swift bridge lands, this code path is
 * unreachable (the loader returns null first).  The shape is here so
 * the runtime can compile against the real binding when it lands
 * without touching app-core wiring.
 */
function buildIosBinding(
  _plugin: CapacitorLlamaStreamingPlugin,
): IosStreamingLlmBinding {
  throw new Error(
    "[ios-llama-streaming] buildIosBinding is a stub. " +
      "The Swift bridge (LlamaStreaming Capacitor plugin) is not yet wired. " +
      "See docs/eliza-1-ios-streaming-status.md for the rollout plan.",
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/* -------------------------------------------------------------------- */
/* Capability probe                                                     */
/* -------------------------------------------------------------------- */

export interface IosInferenceCapabilities {
  /** True only when the iOS Swift bridge is present AND reports streaming-LLM. */
  streamingLlm: boolean;
  /** Always false on iOS until the drafter weights ship in the bundle. */
  dflashSupported: boolean;
  /** Whether the XCFramework reports omnivoice streaming. */
  omnivoiceStreaming: boolean;
  /** Phone-tier iOS devices rarely have headroom for mmproj. */
  mmprojSupported: boolean;
  /**
   * `ProcessInfo.thermalState` snapshot at probe time.  Surfaced so the
   * runtime can refuse to start speculative decoding when the device is
   * already in `serious` / `critical`.  Always `nominal` on the
   * web/sim fallback path.
   */
  thermalState: "nominal" | "fair" | "serious" | "critical";
}
