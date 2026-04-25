import { Button } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../state";
import {
  buildViewerSessionKey,
  resolveEmbeddedViewerUrl,
  resolvePostMessageTargetOrigin,
  resolveViewerReadyEventType,
  shouldUseEmbeddedAppViewer,
} from "./viewer-auth";

export function GameViewOverlay() {
  const {
    appRuns,
    activeGameRunId,
    activeGameDisplayName,
    activeGamePostMessageAuth,
    activeGamePostMessagePayload,
    activeGameViewerUrl,
    activeGameSandbox,
    setState,
    t,
  } = useApp();

  // --- Drag state ---
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const authSentRef = useRef(false);
  const viewerSessionRef = useRef("");
  const activeGameRun = useMemo(
    () => appRuns.find((run) => run.runId === activeGameRunId) ?? null,
    [activeGameRunId, appRuns],
  );
  const useEmbeddedViewer = useMemo(
    () => shouldUseEmbeddedAppViewer(activeGameRun),
    [activeGameRun],
  );
  const resolvedActiveGameViewerUrl = useMemo(
    () => resolveEmbeddedViewerUrl(activeGameViewerUrl),
    [activeGameViewerUrl],
  );
  const postMessageTargetOrigin = useMemo(
    () => resolvePostMessageTargetOrigin(activeGameViewerUrl),
    [activeGameViewerUrl],
  );
  const viewerSessionKey = useMemo(
    () =>
      buildViewerSessionKey(activeGameViewerUrl, activeGamePostMessagePayload),
    [activeGamePostMessagePayload, activeGameViewerUrl],
  );

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      setPos({
        x: ev.clientX - dragOffset.current.x,
        y: ev.clientY - dragOffset.current.y,
      });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const handleClose = useCallback(() => {
    setState("gameOverlayEnabled", false);
  }, [setState]);

  const handleExpand = useCallback(() => {
    setState("gameOverlayEnabled", false);
    setState("tab", "apps");
    setState("appsSubTab", "games");
  }, [setState]);

  useEffect(() => {
    if (viewerSessionRef.current !== viewerSessionKey) {
      viewerSessionRef.current = viewerSessionKey;
      authSentRef.current = false;
    }
  }, [viewerSessionKey]);

  useEffect(() => {
    if (
      !useEmbeddedViewer ||
      !activeGamePostMessageAuth ||
      !activeGamePostMessagePayload
    ) {
      return;
    }
    if (authSentRef.current) {
      return;
    }

    const expectedReadyType = resolveViewerReadyEventType(
      activeGamePostMessagePayload,
    );
    if (!expectedReadyType) {
      return;
    }

    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (authSentRef.current) return;
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) return;
      if (event.data?.type !== expectedReadyType) return;
      if (
        postMessageTargetOrigin !== "*" &&
        event.origin !== postMessageTargetOrigin
      ) {
        return;
      }

      iframeWindow.postMessage(
        activeGamePostMessagePayload,
        postMessageTargetOrigin,
      );
      authSentRef.current = true;
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [
    activeGamePostMessageAuth,
    activeGamePostMessagePayload,
    postMessageTargetOrigin,
    useEmbeddedViewer,
  ]);

  if (
    !resolvedActiveGameViewerUrl ||
    activeGameRun?.viewerAttachment !== "attached"
  ) {
    return null;
  }

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" }
    : { right: 16, bottom: 16 };

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <div
        ref={containerRef}
        className="absolute w-[480px] h-[360px] pointer-events-auto rounded-xl overflow-hidden flex flex-col"
        style={{
          resize: "both",
          background: "rgba(18, 22, 32, 0.96)",
          border: "1px solid rgba(240, 178, 50, 0.18)",
          boxShadow:
            "0 8px 60px rgba(0,0,0,0.6), 0 0 40px rgba(240,178,50,0.06)",
          ...style,
        }}
      >
        {/* Drag handle / header */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 select-none"
          style={{
            cursor: dragging ? "grabbing" : "grab",
            background: "rgba(255,255,255,0.04)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <Button
            variant="ghost"
            className="font-bold text-xs-tight truncate flex-1 text-left cursor-inherit h-auto p-0"
            style={{ color: "rgba(240,238,250,0.92)" }}
            onMouseDown={handleDragStart}
            aria-label={t("aria.dragOverlay")}
          >
            {activeGameDisplayName || "Game"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-2xs px-2 py-0.5 h-auto"
            style={{
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.04)",
              color: "rgba(240,238,250,0.92)",
            }}
            onClick={handleExpand}
            title={t("gameviewoverlay.ExpandBackToApps")}
          >
            {t("common.expand")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-2xs px-2 py-0.5 h-auto"
            style={{
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.04)",
              color: "rgba(240,238,250,0.92)",
            }}
            onClick={handleClose}
            title={t("gameviewoverlay.CloseOverlay")}
          >
            {t("common.close")}
          </Button>
        </div>
        {/* Iframe */}
        <iframe
          ref={iframeRef}
          src={resolvedActiveGameViewerUrl}
          sandbox={activeGameSandbox}
          data-testid="game-view-overlay-iframe"
          className="flex-1 w-full border-none"
          title={activeGameDisplayName || "Game Overlay"}
        />
      </div>
    </div>
  );
}
