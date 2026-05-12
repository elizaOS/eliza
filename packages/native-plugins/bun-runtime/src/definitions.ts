/**
 * @elizaos/capacitor-bun-runtime — iOS embedded Bun-shape JS runtime.
 *
 * Hosts a JavaScriptCore JSContext on a dedicated worker thread. The native
 * plugin either starts a bundled full Bun engine framework or installs the
 * `__MILADY_BRIDGE__` host functions for the compatibility JSContext path.
 * The full-engine ABI lives in packages/bun-ios-runtime/BRIDGE_CONTRACT.md.
 *
 * The plugin exposes a tiny surface to the React UI: start the runtime,
 * send messages, check status, and stop it. Everything else flows over the
 * `ui_post_message` / `ui_register_handler` channel inside the native side.
 */

export interface StartOptions {
  /**
   * Runtime engine selection:
   * - "auto" (default): use a bundled full Bun engine when present, otherwise
   *   fall back to the JSContext compatibility bridge.
   * - "bun": require ElizaBunEngine.framework and fail if it is missing.
   * - "compat": force the JSContext compatibility bridge.
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
   * `["bun", "public/agent/agent-bundle.js"]`.
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
