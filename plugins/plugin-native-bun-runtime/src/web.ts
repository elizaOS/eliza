import { WebPlugin } from "@capacitor/core";
import type {
  CallOptions,
  CallResult,
  ElizaBunRuntimePlugin,
  GetStatusResult,
  LocalTtsDiagnosticsOptions,
  LocalTtsDiagnosticsResult,
  LocalTtsStatusResult,
  SendMessageOptions,
  SendMessageResult,
  SynthesizeLocalTtsOptions,
  SynthesizeLocalTtsResult,
  StartOptions,
  StartResult,
} from "./definitions";

/**
 * Web fallback for `@elizaos/capacitor-bun-runtime`.
 *
 * Browser environments do not host the native runtime. This implementation
 * reports an unavailable status and throws clear errors for runtime calls.
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
      "ElizaBunRuntime.sendMessage is unavailable on web.",
    );
  }

  async getStatus(): Promise<GetStatusResult> {
    return { ready: false };
  }

  async stop(): Promise<void> {
    return;
  }

  async getLocalTtsStatus(): Promise<LocalTtsStatusResult> {
    return {
      ready: false,
      status: "unavailable",
      message:
        "ElizaBunRuntime local TTS is not available on web. Run on an iOS device or simulator.",
    };
  }

  async getLocalTtsDiagnostics(
    _options?: LocalTtsDiagnosticsOptions,
  ): Promise<LocalTtsDiagnosticsResult> {
    return {
      available: false,
      message:
        "ElizaBunRuntime local TTS diagnostics are not available on web. Run on an iOS device or simulator.",
    };
  }

  async synthesizeLocalTts(
    _options: SynthesizeLocalTtsOptions,
  ): Promise<SynthesizeLocalTtsResult> {
    throw this.unavailable(
      "ElizaBunRuntime.synthesizeLocalTts is unavailable on web.",
    );
  }

  async call(_options: CallOptions): Promise<CallResult> {
    throw this.unavailable("ElizaBunRuntime.call is unavailable on web.");
  }
}
