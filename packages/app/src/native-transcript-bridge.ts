/**
 * Forwards the renderer's real transcript-event stream into the active native
 * host. Capacitor and Electrobun reduce the same envelope independently; the
 * validated host projection then replaces the renderer fold in the shipped
 * React chat surface.
 */

import { Capacitor } from "@capacitor/core";
import { logger } from "@elizaos/logger";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
} from "@elizaos/ui/bridge";
import {
  acceptNativeTranscriptViewModel,
  NATIVE_TRANSCRIPT_RENDERER_EVENT,
  type NativeTranscriptViewSource,
  type TranscriptEventStream,
} from "@elizaos/ui/native-transcript";

interface NativeTranscriptPlugin {
  publishStream(
    options: TranscriptEventStream,
  ): Promise<{ view: unknown; rejectedIndexes: number[] }>;
  readViewModel(): Promise<{ view: unknown }>;
}

let cleanupInstalledBridge: (() => void) | null = null;

interface NativeTranscriptHostResponse {
  view: unknown;
  rejectedIndexes: number[];
}

function decodeHostResponse(raw: unknown): NativeTranscriptHostResponse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Native transcript host returned a non-object response");
  }
  const source = raw as Record<string, unknown>;
  if (!("view" in source)) {
    throw new Error("Native transcript host response is missing view");
  }
  if (!Array.isArray(source.rejectedIndexes)) {
    throw new Error(
      "Native transcript host response has invalid rejectedIndexes",
    );
  }
  const rejectedIndexes: number[] = [];
  for (const value of source.rejectedIndexes) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error(
        "Native transcript host response has invalid rejectedIndexes",
      );
    }
    rejectedIndexes.push(value);
  }
  return {
    view: source.view,
    rejectedIndexes,
  };
}

function nativeCapacitorSource(): Exclude<
  NativeTranscriptViewSource,
  "web" | "desktop"
> {
  const platform = Capacitor.getPlatform();
  if (platform === "ios" || platform === "android") return platform;
  throw new Error(`Unsupported native transcript platform: ${platform}`);
}

/** Install the active platform transcript adapter once per renderer lifetime. */
export function installNativeTranscriptPlatformBridge(): void {
  if (cleanupInstalledBridge) return;

  let publishStream:
    | ((stream: TranscriptEventStream) => Promise<unknown>)
    | null = null;
  let nativeSource: Exclude<NativeTranscriptViewSource, "web"> | null = null;
  if (Capacitor.isNativePlatform()) {
    const plugin =
      Capacitor.registerPlugin<NativeTranscriptPlugin>("NativeTranscript");
    publishStream = (stream) => plugin.publishStream(stream);
    nativeSource = nativeCapacitorSource();
  } else if (isElectrobunRuntime()) {
    publishStream = (stream) =>
      invokeDesktopBridgeRequest({
        rpcMethod: "nativeTranscriptPublishStream",
        ipcChannel: "native-transcript:publishStream",
        params: stream,
      });
    nativeSource = "desktop";
  }

  const onStream = (event: Event): void => {
    if (!publishStream || !nativeSource) return;
    const stream = (event as CustomEvent<TranscriptEventStream>).detail;
    const source = nativeSource;
    void publishStream(stream)
      .then((rawResponse) => {
        const response = decodeHostResponse(rawResponse);
        if (response.rejectedIndexes.length > 0) {
          throw new Error(
            `Native transcript host rejected event indexes: ${response.rejectedIndexes.join(", ")}`,
          );
        }
        const accepted = acceptNativeTranscriptViewModel(response.view, source);
        if (!accepted.ok) {
          throw new Error(
            `Native transcript view rejected at ${accepted.error.path}: ${accepted.error.message}`,
          );
        }
      })
      .catch((error) => {
        // error-policy:J5 this rejection is observed here and the product keeps
        // the renderer-reduced snapshot as its explicit native-bridge fallback.
        logger.error(
          { error },
          "[NativeTranscript] Could not publish transcript stream to native host",
        );
      });
  };
  window.addEventListener(NATIVE_TRANSCRIPT_RENDERER_EVENT, onStream);
  cleanupInstalledBridge = () => {
    window.removeEventListener(NATIVE_TRANSCRIPT_RENDERER_EVENT, onStream);
    cleanupInstalledBridge = null;
  };
}

export function resetNativeTranscriptPlatformBridgeForTests(): void {
  cleanupInstalledBridge?.();
}
