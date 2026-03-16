import { useCallback, useEffect, useRef } from "react";
import {
  getLifoSyncChannelName,
  type LifoRuntime,
  type LifoSyncMessage,
  normalizeTerminalText,
} from "../platform";

interface UseLifoSyncOptions {
  popoutMode: boolean;
  lifoSessionId: string | null;
  runtimeRef: React.RefObject<LifoRuntime | null>;
  appendOutput: (line: string) => void;
  setRunCount: React.Dispatch<React.SetStateAction<number>>;
  setSessionKey: React.Dispatch<React.SetStateAction<number>>;
  setControllerOnline: React.Dispatch<React.SetStateAction<boolean>>;
  controllerHeartbeatAtRef: React.MutableRefObject<number>;
}

interface UseLifoSyncReturn {
  broadcastSyncMessage: (message: Omit<LifoSyncMessage, "source">) => void;
  syncChannelRef: React.RefObject<BroadcastChannel | null>;
}

export function useLifoSync({
  popoutMode,
  lifoSessionId,
  runtimeRef,
  appendOutput,
  setRunCount,
  setSessionKey,
  setControllerOnline,
  controllerHeartbeatAtRef,
}: UseLifoSyncOptions): UseLifoSyncReturn {
  const syncChannelRef = useRef<BroadcastChannel | null>(null);

  const broadcastSyncMessage = useCallback(
    (message: Omit<LifoSyncMessage, "source">) => {
      if (!popoutMode) return;
      syncChannelRef.current?.postMessage({
        source: "controller",
        ...message,
      } satisfies LifoSyncMessage);
    },
    [popoutMode],
  );

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;

    const channel = new BroadcastChannel(getLifoSyncChannelName(lifoSessionId));
    syncChannelRef.current = channel;

    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let heartbeatWatchInterval: ReturnType<typeof setInterval> | null = null;

    if (popoutMode) {
      setControllerOnline(true);
      broadcastSyncMessage({ type: "heartbeat" });
      heartbeatInterval = setInterval(() => {
        broadcastSyncMessage({ type: "heartbeat" });
      }, 1000);
    } else {
      heartbeatWatchInterval = setInterval(() => {
        const online = Date.now() - controllerHeartbeatAtRef.current < 3500;
        setControllerOnline(online);
      }, 1000);
    }

    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (popoutMode) return;
      const data = event.data as Partial<LifoSyncMessage> | null;
      if (!data || data.source !== "controller") return;

      if (data.type === "heartbeat") {
        controllerHeartbeatAtRef.current = Date.now();
        setControllerOnline(true);
        return;
      }

      const runtime = runtimeRef.current;
      if (!runtime) return;

      switch (data.type) {
        case "session-reset":
          setSessionKey((value) => value + 1);
          break;
        case "command-start":
          if (typeof data.command !== "string") return;
          runtime.terminal.writeln(`$ ${data.command}`);
          appendOutput(`$ ${data.command}`);
          setRunCount((prev) => prev + 1);
          break;
        case "stdout":
          if (typeof data.chunk !== "string") return;
          runtime.terminal.write(normalizeTerminalText(data.chunk));
          if (data.chunk.trimEnd()) appendOutput(data.chunk.trimEnd());
          break;
        case "stderr":
          if (typeof data.chunk !== "string") return;
          runtime.terminal.write(normalizeTerminalText(data.chunk));
          if (data.chunk.trimEnd()) {
            appendOutput(`stderr: ${data.chunk.trimEnd()}`);
          }
          break;
        case "command-exit":
          if (typeof data.exitCode !== "number") return;
          runtime.terminal.writeln(`[exit ${data.exitCode}]`);
          appendOutput(`[exit ${data.exitCode}]`);
          try {
            runtime.explorer.refresh();
          } catch {
            // Ignore refresh failures when mirroring popout events.
          }
          break;
        case "command-error":
          if (typeof data.message !== "string") return;
          runtime.terminal.writeln(`error: ${data.message}`);
          appendOutput(`error: ${data.message}`);
          break;
      }
    };

    return () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (heartbeatWatchInterval) clearInterval(heartbeatWatchInterval);
      syncChannelRef.current = null;
      channel.close();
    };
  }, [
    appendOutput,
    broadcastSyncMessage,
    controllerHeartbeatAtRef,
    lifoSessionId,
    popoutMode,
    runtimeRef,
    setControllerOnline,
    setRunCount,
    setSessionKey,
  ]);

  return { broadcastSyncMessage, syncChannelRef };
}
