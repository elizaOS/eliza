/**
 * @elizaos/capacitor-bun-runtime — iOS embedded Bun-shape JS runtime.
 *
 * Hosts a JavaScriptCore JSContext on a dedicated worker thread. The native
 * plugin installs the `__MILADY_BRIDGE__` host functions (see
 * `BRIDGE_CONTRACT.md` in this repo) and loads an agent bundle that uses
 * those functions through the polyfill layer.
 *
 * The plugin exposes a tiny surface to the React UI: start the runtime,
 * send messages, check status, and stop it. Everything else flows over the
 * `ui_post_message` / `ui_register_handler` channel inside the native side.
 */

export interface StartOptions {
  /**
   * Path to the agent bundle JavaScript file. When omitted, the runtime
   * loads `agent-bundle-ios.js` from the main app bundle resources.
   * Use this only for development overrides.
   */
  bundlePath?: string;
  /**
   * Optional polyfill prefix loaded before the agent bundle. When omitted,
   * the runtime loads `milady-polyfill-prefix.js` from the main app bundle
   * resources, or falls back to a minimal embedded prefix.
   */
  polyfillPath?: string;
  /**
   * Initial environment variables visible to the agent via `env_get` / `env_keys`.
   */
  env?: Record<string, string>;
  /**
   * argv vector exposed to the agent via `argv()`. Defaults to
   * `["bun", "agent-bundle-ios.js"]`.
   */
  argv?: string[];
}

export interface StartResult {
  ok: boolean;
  error?: string;
  /** Version string emitted by `__MILADY_BRIDGE_VERSION__`. */
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

export interface ElizaBunRuntimePlugin {
  start(options: StartOptions): Promise<StartResult>;
  sendMessage(options: SendMessageOptions): Promise<SendMessageResult>;
  getStatus(): Promise<GetStatusResult>;
  stop(): Promise<void>;
  /**
   * Invoke an arbitrary UI handler that the agent has registered via
   * `bridge.ui_register_handler`. Useful for routing arbitrary RPC-style
   * traffic from the React UI into the agent.
   */
  call(options: CallOptions): Promise<CallResult>;
}
