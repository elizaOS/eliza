/**
 * Draggable floating "kiosk" overlay that keeps the active game run's iframe
 * visible across non-Views tabs — mounted once at the App shell root and driven
 * by the active-game fields on the app store. Delegates the authenticated
 * viewer path to `EmbeddedAppViewer` via `shouldUseEmbeddedAppViewer`, and tears
 * the iframe down when the document is backgrounded so the game loop and its
 * postMessage auth listener stop running even if the overlay stays mounted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRafCoalescer } from "../../gestures";
import { useDocumentVisibility } from "../../hooks/useDocumentVisibility";
import { useAppSelectorShallow } from "../../state";
import { Button } from "../ui/button";
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
  } = useAppSelectorShallow((s) => ({
    appRuns: s.appRuns,
    activeGameRunId: s.activeGameRunId,
    activeGameDisplayName: s.activeGameDisplayName,
    activeGamePostMessageAuth: s.activeGamePostMessageAuth,
    activeGamePostMessagePayload: s.activeGamePostMessagePayload,
    activeGameViewerUrl: s.activeGameViewerUrl,
    activeGameSandbox: s.activeGameSandbox,
    setState: s.setState,
    t: s.t,
  }));

  // --- Drag state ---
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  // Viewport position of the overlay when the drag began — the base the
  // per-frame translate3d delta is measured from.
  const dragBaseRef = useRef({ x: 0, y: 0 });
  const dragPendingPosRef = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // During a drag the overlay is moved with a compositor-only translate3d
  // written straight onto the element, at most once per frame — not a
  // per-frame setPos, whose left/top style write re-lays-out the overlay
  // (iframe included) every frame. State commits once on release.
  const { schedule: scheduleDragWrite, cancel: cancelDragWrite } =
    useRafCoalescer<{ x: number; y: number }>((next) => {
      const el = containerRef.current;
      if (!el) return;
      el.style.transform = `translate3d(${next.x - dragBaseRef.current.x}px, ${next.y - dragBaseRef.current.y}px, 0)`;
    });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const authSentRef = useRef(false);
  const viewerSessionRef = useRef("");
  // Safety net: when the kiosk tab/document is backgrounded, tear the iframe
  // down so the game loop and its postMessage auth listener stop running. The
  // primary unmount path is App.tsx's render condition; this guards the case
  // where the overlay stays in the tree but is no longer the foreground.
  const documentVisible = useDocumentVisibility();
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

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // One rect read at drag start (never in the move handler): it is both
      // the grab offset and the translate3d base. The overlay's absolute
      // container fills the viewport, so rect coordinates ARE left/top values.
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragOffset.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      dragBaseRef.current = { x: rect.left, y: rect.top };
      setDragging(true);

      const onMove = (ev: MouseEvent) => {
        const next = {
          x: ev.clientX - dragOffset.current.x,
          y: ev.clientY - dragOffset.current.y,
        };
        dragPendingPosRef.current = next;
        scheduleDragWrite(next);
      };
      const onUp = () => {
        setDragging(false);
        // Commit: drop any pending frame, write the final left/top directly
        // (the anchor moves from right/bottom to left/top on first drag),
        // clear the drag transform, then sync state for the next render.
        cancelDragWrite();
        const last = dragPendingPosRef.current;
        const el = containerRef.current;
        if (el) {
          el.style.transform = "";
          if (last) {
            el.style.left = `${last.x}px`;
            el.style.top = `${last.y}px`;
            el.style.right = "auto";
            el.style.bottom = "auto";
          }
        }
        if (last) {
          setPos(last);
          dragPendingPosRef.current = null;
        }
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [cancelDragWrite, scheduleDragWrite],
  );

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

  // Hiding the document unmounts the iframe; on re-show it remounts with a
  // fresh contentWindow that re-emits its ready event, so the auth handshake
  // must run again even within the same viewer session.
  useEffect(() => {
    if (!documentVisible) {
      authSentRef.current = false;
    }
  }, [documentVisible]);

  useEffect(() => {
    if (
      !documentVisible ||
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

    // Fail closed: without a concrete http(s) origin we can neither verify the
    // sender nor safely target the auth payload, so never send it.
    if (!postMessageTargetOrigin) {
      return;
    }

    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (authSentRef.current) return;
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) return;
      if (event.data?.type !== expectedReadyType) return;
      if (event.origin !== postMessageTargetOrigin) {
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
    documentVisible,
    activeGamePostMessageAuth,
    activeGamePostMessagePayload,
    postMessageTargetOrigin,
    useEmbeddedViewer,
  ]);

  if (
    !documentVisible ||
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
        className="absolute w-[480px] h-[360px] pointer-events-auto rounded-sm overflow-hidden flex flex-col"
        style={{
          resize: "both",
          background: "rgba(18, 22, 32, 0.96)",
          border: "1px solid rgba(240, 178, 50, 0.18)",
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
