/**
 * @elizaos/capacitor-bun-runtime — iOS embedded Bun-shape JS runtime.
 *
 * Hosts a JavaScriptCore JSContext on a dedicated worker thread. The native
 * plugin either starts a bundled full Bun engine framework or installs the
 * `__ELIZA_BRIDGE__` host functions for the compatibility JSContext path.
 * The full-engine ABI lives in packages/native/bun-runtime/BRIDGE_CONTRACT.md.
 *
 * The plugin exposes a tiny surface to the React UI: start the runtime,
 * send messages, check status, and stop it. Everything else flows over the
 * `ui_post_message` / `ui_register_handler` channel inside the native side.
 */

export interface StartOptions {
  /**
   * Runtime engine selection:
   * - "auto" (default): use a bundled full Bun engine when present. The
   *   JSContext compatibility fallback is for development/sideload builds only;
   *   iOS store local mode must request "bun" and fail if the engine is missing.
   * - "bun": require ElizaBunEngine.framework and fail if it is missing.
   * - "compat": force the JSContext compatibility bridge for development.
   */
  engine?: "auto" | "bun" | "compat";
  /**
   * Path to the agent bundle JavaScript file. When omitted, the runtime
   * loads the staged iOS agent payload from `public/agent/agent-bundle.js`
   * in the main app bundle resources. Legacy JSContext development bundles
   * named `agent-bundle-ios.js` are still probed for compatibility.
   * Use this only for development overrides.
   */
  bundlePath?: string;
  /**
   * Optional polyfill prefix loaded before the agent bundle. When omitted,
   * the runtime loads `eliza-polyfill-prefix.js` from the main app bundle
   * resources, or falls back to a minimal embedded prefix.
   */
  polyfillPath?: string;
  /**
   * Initial environment variables visible to the agent via `env_get` / `env_keys`.
   */
  env?: Record<string, string>;
  /**
   * argv vector exposed to the agent via `argv()`. Defaults to
   * `["bun", "public/agent/agent-bundle.js"]`.
   */
  argv?: string[];
}

export interface StartResult {
  ok: boolean;
  error?: string;
  /** Version string emitted by `__ELIZA_BRIDGE_VERSION__`. */
  bridgeVersion?: string;
}

export interface SendMessageOptions {
  message: string;
  /** Optional conversation/thread identifier passed through to the agent. */
  conversationId?: string;
}

export interface SendMessageResult {
  reply: string;
}

export interface GetStatusResult {
  ready: boolean;
  /** Active runtime engine: full Bun framework or compatibility bridge. */
  engine?: "bun" | "compat";
  /** Currently loaded llama model path, if any. */
  model?: string;
  /** Last observed generation throughput. */
  tokensPerSecond?: number;
  /** Bridge version string, e.g. "v1". */
  bridgeVersion?: string;
}

/**
 * Generic call surface for any UI handler the agent has registered via
 * `bridge.ui_register_handler`. The React UI passes a method name and args;
 * the native plugin dispatches into the JSContext and returns the result.
 */
export interface CallOptions {
  method: string;
  args?: unknown;
}

export interface CallResult {
  result: unknown;
}

/** Handle returned by `addListener`; call `remove` to detach the listener. */
export interface PluginListenerHandle {
  remove: () => Promise<void>;
}

/**
 * Chat token-stream events the native side pushes to the WebView while a
 * `call({ method: "http_request_stream" })` runs (#12354). They mirror the
 * Android `Agent` plugin's streaming contract so the shared
 * `createNativeStreamingResponse` adapter reconstructs a live `ReadableStream`:
 * one `agentStreamResponse` head, then `agentStreamChunk` per token, then
 * `agentStreamComplete`.
 */
export type AgentStreamEventName =
  | "agentStreamResponse"
  | "agentStreamChunk"
  | "agentStreamComplete";

export interface LocalTtsStatusResult {
  ready: boolean;
  status: "assets-ready" | "engine-ready" | "ready" | "missing" | "unavailable";
  message: string;
  modelId?: string;
  bundleDir?: string;
}

export interface LocalTtsDiagnosticsOptions {
  bundleDir?: string;
  probe?: boolean;
  text?: string;
}

export interface LocalTtsDiagnosticsResult {
  available: boolean;
  selectedBundleDir?: string;
  modelId?: string;
  message?: string;
  [key: string]: unknown;
}

export interface SynthesizeLocalTtsOptions {
  text: string;
  bundleDir?: string;
  speakerPresetId?: string;
  voice?: string;
  voiceId?: string;
  maxSamples?: number;
  play?: boolean;
}

export interface SynthesizeLocalTtsResult {
  audioBase64?: string;
  contentType: "audio/wav";
  sampleRate: number;
  samples: number;
  durationMs: number;
  modelId?: string;
  played?: boolean;
}

export interface ElizaBunRuntimePlugin {
  start(options: StartOptions): Promise<StartResult>;
  sendMessage(options: SendMessageOptions): Promise<SendMessageResult>;
  getStatus(): Promise<GetStatusResult>;
  stop(): Promise<void>;
  getLocalTtsStatus(): Promise<LocalTtsStatusResult>;
  getLocalTtsDiagnostics(
    options?: LocalTtsDiagnosticsOptions,
  ): Promise<LocalTtsDiagnosticsResult>;
  synthesizeLocalTts(
    options: SynthesizeLocalTtsOptions,
  ): Promise<SynthesizeLocalTtsResult>;
  /**
   * Invoke an arbitrary UI handler that the agent has registered via
   * `bridge.ui_register_handler`. Useful for routing arbitrary RPC-style
   * traffic from the React UI into the agent.
   */
  call(options: CallOptions): Promise<CallResult>;
  /**
   * Subscribe to a native event. Used for the chat token stream: the streaming
   * adapter attaches `agentStream*` listeners before invoking
   * `call({ method: "http_request_stream" })` (#12354).
   */
  addListener(
    eventName: AgentStreamEventName,
    listener: (event: unknown) => void,
  ): Promise<PluginListenerHandle>;
}
