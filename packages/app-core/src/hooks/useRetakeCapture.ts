/**
 * Hook that controls desktop native frame capture for retake.tv streaming.
 *
 * Uses the native desktop capture path through the renderer bridge — this captures
 * the full compositor output including cross-origin iframes (unlike the old canvas approach
 * which was blocked by same-origin policy).
 *
 * The main process handles capture + HTTP POST to /api/stream/frame directly.
 * This hook just sends start/stop signals.
 */

import { useEffect, useRef } from "react";
import { invokeDesktopBridgeRequest } from "../bridge";
import { getElizaApiBase } from "../utils/eliza-globals";

const DEFAULT_FPS = 15;
const JPEG_QUALITY = 70;

export function useRetakeCapture(
  _iframeRef: React.RefObject<HTMLIFrameElement | null>,
  active: boolean,
  fps = DEFAULT_FPS,
) {
  const activeRef = useRef(false);

  useEffect(() => {
    if (active && !activeRef.current) {
      activeRef.current = true;
      void invokeDesktopBridgeRequest({
        rpcMethod: "screencaptureStartFrameCapture",
        ipcChannel: "screencapture:startFrameCapture",
        params: {
          fps,
          quality: JPEG_QUALITY,
          apiBase: getElizaApiBase() ?? "http://localhost:2138",
          endpoint: "/api/stream/frame",
        },
      })
        .then((result) => {
          if (result === null) {
            activeRef.current = false;
          }
        })
        .catch((err) => {
          console.warn("[retake] Failed to start frame capture:", err);
          activeRef.current = false;
        });
    } else if (!active && activeRef.current) {
      activeRef.current = false;
      void invokeDesktopBridgeRequest({
        rpcMethod: "screencaptureStopFrameCapture",
        ipcChannel: "screencapture:stopFrameCapture",
      }).catch((err) => {
        console.warn("[retake] Failed to stop frame capture:", err);
      });
    }

    return () => {
      if (activeRef.current) {
        activeRef.current = false;
        void invokeDesktopBridgeRequest({
          rpcMethod: "screencaptureStopFrameCapture",
          ipcChannel: "screencapture:stopFrameCapture",
        }).catch(() => {});
      }
    };
  }, [active, fps]);
}
