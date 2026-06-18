/**
 * XR simulation harness. Renders the real spatial views (XR modality DOM) as
 * holographic panels positioned in a simulated headset space using CSS 3D
 * (perspective + transforms) — the same screen-space-DOM approach app-xr uses
 * for real headsets, but driveable and screenshottable in Playwright without
 * hardware. Exposes `window.__xrsim` so the e2e spec can move the head, aim and
 * fire the controller, switch views, type in the chat bar, and toggle voice.
 *
 * This is a *simulation for verification*: it proves the spatial views render,
 * frame, and interact correctly when placed in front of the user in 3D.
 */
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { GALLERY } from "../../src/spatial/gallery.tsx";
import { SpatialSurface } from "../../src/spatial/index.ts";

interface Pose {
  yaw: number; // degrees, + = look right
  pitch: number; // degrees, + = look up
}
interface XrEvent {
  type: string;
  detail?: unknown;
  at: number;
}

declare global {
  interface Window {
    __xrsim: {
      ready: boolean;
      listViews: () => string[];
      setView: (id: string) => void;
      getView: () => string;
      setPose: (p: Partial<Pose>) => void;
      getPose: () => Pose;
      /** Aim the controller at a CSS selector (its on-screen centre). */
      aimAt: (selector: string) => boolean;
      /** Fire select at the current reticle position; returns the hit text. */
      select: () => string | null;
      setChat: (text: string) => void;
      submitChat: () => void;
      toggleVoice: () => boolean;
      events: XrEvent[];
    };
  }
}

const PANEL_DISTANCE = 620; // px ≈ 1.5 m at this perspective
const PANEL_WIDTH = 400;

function XrSim() {
  const [viewId, setViewId] = useState<string>(GALLERY[0].id);
  const [pose, setPoseState] = useState<Pose>({ yaw: 0, pitch: 0 });
  const [reticle, setReticle] = useState<{ x: number; y: number }>(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  }));
  const [chat, setChat] = useState("");
  const [voice, setVoice] = useState(false);
  const eventsRef = useRef<XrEvent[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  // The element the controller is aimed at — set synchronously by aimAt so a
  // following select() is deterministic (no dependence on a React re-render or
  // CSS-3D hit-testing precision).
  const aimTargetRef = useRef<HTMLElement | null>(null);
  const reticleRef = useRef(reticle);
  reticleRef.current = reticle;

  const screen = GALLERY.find((s) => s.id === viewId) ?? GALLERY[0];

  const pushEvent = useCallback((type: string, detail?: unknown) => {
    eventsRef.current.push({ type, detail, at: Date.now() });
  }, []);

  // Install the control API for Playwright.
  useEffect(() => {
    window.__xrsim = {
      ready: true,
      events: eventsRef.current,
      listViews: () => GALLERY.map((s) => s.id),
      setView: (id) => {
        aimTargetRef.current = null;
        setViewId(id);
        pushEvent("set-view", id);
      },
      getView: () => viewId,
      setPose: (p) =>
        setPoseState((prev) => ({
          yaw: p.yaw ?? prev.yaw,
          pitch: p.pitch ?? prev.pitch,
        })),
      getPose: () => pose,
      aimAt: (selector) => {
        const el = panelRef.current?.querySelector<HTMLElement>(selector);
        if (!el) return false;
        aimTargetRef.current = el;
        const r = el.getBoundingClientRect();
        setReticle({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        return true;
      },
      select: () => {
        // Prefer the explicitly-aimed element; else hit-test at the reticle.
        const aimed = aimTargetRef.current;
        const pt = reticleRef.current;
        const el =
          aimed ??
          (document.elementFromPoint(pt.x, pt.y) as HTMLElement | null);
        if (!el) return null;
        const target =
          el.closest<HTMLElement>("button,[data-agent-id],input,select") ?? el;
        target.click();
        const label =
          target.getAttribute("data-agent-id") ??
          target.textContent?.trim() ??
          null;
        pushEvent("select", label);
        return label;
      },
      setChat: (text) => {
        setChat(text);
        pushEvent("chat-input", text);
      },
      submitChat: () => {
        pushEvent("chat-submit", chat);
        setChat("");
      },
      toggleVoice: () => {
        let next = false;
        setVoice((v) => {
          next = !v;
          return next;
        });
        pushEvent("voice", next);
        return next;
      },
    };
  }, [viewId, pose, reticle, chat, pushEvent]);

  // Track the reticle to the mouse so manual exploration works too.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      aimTargetRef.current = null;
      setReticle({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // Head yaw right (+) makes a world-anchored panel drift left in view, and
  // looking up (+pitch) makes it drift down — physical head-turn parallax.
  const worldTransform = `rotateX(${pose.pitch}deg) rotateY(${pose.yaw}deg)`;

  return (
    <div
      data-xr-scene
      style={{
        position: "fixed",
        inset: 0,
        perspective: "1000px",
        perspectiveOrigin: "50% 45%",
        overflow: "hidden",
      }}
    >
      {/* The world (head-relative): rotates with the camera pose. */}
      <div
        data-xr-world
        style={{
          position: "absolute",
          inset: 0,
          transformStyle: "preserve-3d",
          transform: worldTransform,
          transition: "transform 0.25s ease",
        }}
      >
        {/* Floor grid for spatial grounding. */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 4000,
            height: 4000,
            marginLeft: -2000,
            transform: "translateY(360px) rotateX(80deg)",
            transformOrigin: "center top",
            background:
              "repeating-linear-gradient(0deg, rgba(130,180,255,0.30) 0 1px, transparent 1px 90px), repeating-linear-gradient(90deg, rgba(130,180,255,0.30) 0 1px, transparent 1px 90px)",
            maskImage:
              "linear-gradient(to bottom, transparent 0%, #000 40%, #000 100%)",
            // biome-ignore lint/style/useNamingConvention: vendor-prefixed CSS
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent 0%, #000 40%, #000 100%)",
          }}
        />

        {/* The active spatial view, floating as a holographic panel. */}
        <div
          ref={panelRef}
          data-xr-panel={viewId}
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: PANEL_WIDTH,
            marginLeft: -PANEL_WIDTH / 2,
            transform: `translateY(-46%) translateZ(-${PANEL_DISTANCE}px)`,
            padding: 14,
            borderRadius: 16,
            border: "1px solid rgba(140,190,255,0.45)",
            background: "rgba(14, 20, 32, 0.82)",
            boxShadow:
              "0 0 0 1px rgba(140,190,255,0.12), 0 24px 80px rgba(0,0,0,0.6), 0 0 60px rgba(80,140,230,0.18)",
            backdropFilter: "blur(2px)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: "rgba(150,200,255,0.7)",
              marginBottom: 8,
            }}
          >
            {viewId} · 1.5 m
          </div>
          <SpatialSurface
            modality="xr"
            onAction={(a) => pushEvent("action", a)}
          >
            {screen.view()}
          </SpatialSurface>
        </div>
      </div>

      {/* --- Headset UI chrome (head-locked, drawn flat over the scene) --- */}

      {/* View rail: switch the active view. */}
      <div
        data-xr-rail
        style={{
          position: "fixed",
          left: 16,
          top: "50%",
          transform: "translateY(-50%)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        {GALLERY.map((s) => (
          <button
            type="button"
            key={s.id}
            data-xr-rail-item={s.id}
            onClick={() => {
              setViewId(s.id);
              pushEvent("set-view", s.id);
            }}
            style={{
              textAlign: "left",
              fontSize: 12,
              padding: "5px 10px",
              borderRadius: 8,
              cursor: "pointer",
              border: "1px solid",
              borderColor:
                s.id === viewId ? "var(--primary)" : "rgba(140,160,190,0.25)",
              background:
                s.id === viewId ? "rgba(232,89,12,0.18)" : "rgba(20,26,38,0.6)",
              color: s.id === viewId ? "#fff" : "var(--muted-foreground)",
            }}
          >
            {s.id}
          </button>
        ))}
      </div>

      {/* Reticle (where the controller points). */}
      <div
        data-xr-reticle
        style={{
          position: "fixed",
          left: reticle.x,
          top: reticle.y,
          width: 14,
          height: 14,
          marginLeft: -7,
          marginTop: -7,
          borderRadius: "50%",
          border: "2px solid rgba(140,200,255,0.9)",
          boxShadow: "0 0 8px rgba(140,200,255,0.7)",
          pointerEvents: "none",
        }}
      />
      {/* Controller ray: from bottom centre to the reticle. */}
      <svg
        style={{ position: "fixed", inset: 0, pointerEvents: "none" }}
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <line
          x1={window.innerWidth / 2}
          y1={window.innerHeight - 8}
          x2={reticle.x}
          y2={reticle.y}
          stroke="rgba(140,200,255,0.55)"
          strokeWidth={2}
        />
      </svg>

      {/* Chat / voice bar (head-locked at the bottom). */}
      <div
        data-xr-chatbar
        style={{
          position: "fixed",
          bottom: 22,
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(560px, 80vw)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: 8,
          borderRadius: 14,
          border: "1px solid rgba(140,160,190,0.25)",
          background: "rgba(12,16,26,0.9)",
        }}
      >
        <button
          type="button"
          data-xr-mic
          onClick={() => {
            setVoice((v) => !v);
            pushEvent("voice", !voice);
          }}
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            border: "1px solid",
            borderColor: voice ? "var(--destructive)" : "rgba(140,160,190,0.4)",
            background: voice ? "rgba(239,68,68,0.85)" : "transparent",
            color: "#fff",
            cursor: "pointer",
            flexShrink: 0,
          }}
          aria-pressed={voice}
        >
          ●
        </button>
        <input
          data-xr-chat-input
          value={chat}
          placeholder={voice ? "Listening…" : "Ask Eliza…"}
          onChange={(e) => setChat(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              pushEvent("chat-submit", chat);
              setChat("");
            }
          }}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            color: "var(--foreground)",
            fontSize: 14,
            outline: "none",
          }}
        />
        <span
          data-xr-voice-indicator={voice ? "active" : "idle"}
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: voice ? "var(--destructive)" : "#333",
            flexShrink: 0,
          }}
        />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <XrSim />
    </StrictMode>,
  );
}
