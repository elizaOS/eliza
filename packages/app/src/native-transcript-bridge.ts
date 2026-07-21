/**
 * Forwards the renderer's real transcript-event stream into the active native
 * host. Capacitor and Electrobun reduce the same envelope independently so
 * app-owned native surfaces can render and inspect the shared view model.
 */

import { Capacitor } from "@capacitor/core";
import { logger } from "@elizaos/logger";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
} from "@elizaos/ui/bridge";
import {
  NATIVE_TRANSCRIPT_RENDERER_EVENT,
  type TranscriptEventStream,
} from "@elizaos/ui/native-transcript";

interface NativeTranscriptPlugin {
  publishStream(
    options: TranscriptEventStream,
  ): Promise<{ view: unknown; rejectedIndexes: number[] }>;
  readViewModel(): Promise<{ view: unknown }>;
}

let cleanupInstalledBridge: (() => void) | null = null;

/** Install the active platform transcript adapter once per renderer lifetime. */
export function installNativeTranscriptPlatformBridge(): void {
  if (cleanupInstalledBridge) return;

  let publishStream:
    | ((stream: TranscriptEventStream) => Promise<unknown>)
    | null = null;
  if (Capacitor.isNativePlatform()) {
    const plugin =
      Capacitor.registerPlugin<NativeTranscriptPlugin>("NativeTranscript");
    publishStream = (stream) => plugin.publishStream(stream);
  } else if (isElectrobunRuntime()) {
    publishStream = (stream) =>
      invokeDesktopBridgeRequest({
        rpcMethod: "nativeTranscriptPublishStream",
        ipcChannel: "native-transcript:publishStream",
        params: stream,
      });
  }

  const onStream = (event: Event): void => {
    if (!publishStream) return;
    const stream = (event as CustomEvent<TranscriptEventStream>).detail;
    void publishStream(stream).catch((error) => {
      // error-policy:J5 the native mirror is auxiliary; its rejection is
      // observed here while the renderer-owned transcript remains available.
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
