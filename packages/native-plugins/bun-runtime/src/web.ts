import { WebPlugin } from "@capacitor/core";
import type {
  CallOptions,
  CallResult,
  ElizaBunRuntimePlugin,
  GetStatusResult,
  SendMessageOptions,
  SendMessageResult,
  StartOptions,
  StartResult,
} from "./definitions";

/**
 * Web fallback for `@elizaos/capacitor-bun-runtime`.
 *
 * There is no JavaScriptCore in browser environments. The runtime is
 * iOS-only today; Android will get a JNI-backed implementation in a
 * follow-up pass. This stub throws a clear error so callers know the plugin
 * isn't available on this platform.
 */
export class ElizaBunRuntimeWeb
  extends WebPlugin
  implements ElizaBunRuntimePlugin
{
  async start(_options: StartOptions): Promise<StartResult> {
    return {
      ok: false,
      error:
        "ElizaBunRuntime is not available on web. Run on an iOS device or simulator.",
    };
  }

  async sendMessage(_options: SendMessageOptions): Promise<SendMessageResult> {
    throw this.unavailable(
      "ElizaBunRuntime.sendMessage is unavailable on web (iOS only for now).",
    );
  }

  async getStatus(): Promise<GetStatusResult> {
    return { ready: false };
  }

  async stop(): Promise<void> {
    return;
  }

  async call(_options: CallOptions): Promise<CallResult> {
    throw this.unavailable(
      "ElizaBunRuntime.call is unavailable on web (iOS only for now).",
    );
  }
}
