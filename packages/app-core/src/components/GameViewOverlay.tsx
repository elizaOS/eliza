/**
 * GameViewOverlay — compact floating iframe overlay that persists across tabs.
 *
 * Rendered at the App.tsx level so it stays visible when the user navigates
 * away from the Apps tab. Provides drag, resize, and close controls.
 */

import { useCallback, useRef, useState } from "react";
import { useApp } from "../state";

export function GameViewOverlay() {
  const {
    activeGameDisplayName,
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

  if (!activeGameViewerUrl) return null;

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
          <button
            type="button"
            className="font-bold text-[11px] truncate flex-1 text-left cursor-inherit bg-transparent border-0"
            style={{ color: "rgba(240,238,250,0.92)" }}
            onMouseDown={handleDragStart}
            aria-label="Drag overlay"
          >
            {activeGameDisplayName || "Game"}
          </button>
          <button
            type="button"
            className="text-[10px] px-2 py-0.5 cursor-pointer transition-colors"
            style={{
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.04)",
              color: "rgba(240,238,250,0.92)",
            }}
            onClick={handleExpand}
            title={t("gameviewoverlay.ExpandBackToApps")}
          >
            {t("gameviewoverlay.Expand")}
          </button>
          <button
            type="button"
            className="text-[10px] px-2 py-0.5 cursor-pointer transition-colors"
            style={{
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.04)",
              color: "rgba(240,238,250,0.92)",
            }}
            onClick={handleClose}
            title={t("gameviewoverlay.CloseOverlay")}
          >
            {t("bugreportmodal.Close")}
          </button>
        </div>
        {/* Iframe */}
        <iframe
          src={activeGameViewerUrl}
          sandbox={activeGameSandbox}
          className="flex-1 w-full border-none"
          title={activeGameDisplayName || "Game Overlay"}
        />
      </div>
    </div>
  );
}
