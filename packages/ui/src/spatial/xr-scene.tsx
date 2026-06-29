/**
 * XRSpatialScene — the real spatial renderer for the XR modality.
 *
 * This is the renderer the WEBXR_STATUS note promised: authored spatial views are
 * placed as panels at true 3D world poses (position, orientation, depth) in front
 * of a movable headset camera, not as flat 2D DOM. Each panel is a real
 * {@link SpatialSurface} (so `data-agent-id` hooks, the agent-surface registry,
 * and `document.elementFromPoint` all keep working), positioned every frame by
 * projecting its 3D pose through {@link projectToScreen} ({@link xr-scene-math}).
 * A controller ray is intersected with the panel planes in world space; the
 * nearest hit maps back to a DOM element, so "the right controller hit Submit" is
 * a computed 3D fact.
 *
 * Scope / honesty: this is a **simulator-grade** renderer — it composites panels
 * with CSS transforms so the whole pose→ray→hit→press→drag loop is deterministic
 * and headless-testable in CI (the IWER harness drives it). Rendering the same
 * panels into a headset's WebGL compositor on-device is the native renderer's job
 * and stays out of scope (see plugin-xr WEBXR_STATUS). Panels billboard to face
 * the viewer; the math core supports arbitrarily-oriented planes for the
 * on-device path.
 *
 * The scene publishes an imperative control surface on `window.__elizaXRScene`
 * that the IWER emulator and Playwright drive (start poses → cast rays → read
 * hits → press/drag). Positioning is imperative (via refs) so a `sync()` updates
 * the DOM synchronously before a hit-test reads it back.
 */

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import type { SpatialAction } from "./context.ts";
import { SpatialSurface } from "./dom.tsx";
import {
  billboardOrientation,
  type Camera,
  nearestPanelHit,
  type PanelPlane,
  panelLocalToWorld,
  panelScreenSize,
  projectToScreen,
  type Quat,
  quatIdentity,
  quatLookAt,
  type Ray,
  rotateVec3,
  type Vec3,
  vec3,
} from "./xr-scene-math.ts";

/** A device pose (headset or controller) in world space. */
export interface XRDevicePose {
  position: Vec3;
  orientation: Quat;
}

/** One authored view placed in the scene as a 3D panel. */
export interface XRPanelSpec {
  id: string;
  content: ReactNode;
  /** World position of the panel centre. Omit to auto-arrange on a frontal arc. */
  position?: Vec3;
  /** Panel width in metres (default 1.2). */
  width?: number;
  /** Panel height in metres (default 0.9). */
  height?: number;
  /**
   * Follow-mode: keep the panel at a fixed offset in the headset's local frame so
   * it tracks head movement (a head-locked HUD panel). Omit for a world-anchored
   * panel that stays put as the head moves.
   */
  followOffset?: Vec3;
}

export interface XRSpatialSceneProps {
  panels: XRPanelSpec[];
  /** Initial headset pose. The scene also tracks the live IWER pose when present. */
  head?: XRDevicePose;
  /** Vertical field of view in radians (default 60°). */
  fovY?: number;
  /** Panel design resolution: DOM px per world metre (default 900). */
  pixelsPerMeter?: number;
  /** Distance (m) panels are auto-arranged in front of the head (default 2.4). */
  arrangeDistance?: number;
  /** Receives primitive actions (press/change/submit) and scene moves. */
  onAction?: (action: SpatialAction) => void;
}

/** Per-panel placement the scene computed this frame. */
export interface XRScenePanelInfo {
  id: string;
  position: Vec3;
  orientation: Quat;
  width: number;
  height: number;
  /** Screen-space rect in CSS px (viewport-absolute). */
  screenRect: { left: number; top: number; width: number; height: number };
  depth: number;
  visible: boolean;
}

/** The result of casting a ray into the scene. */
export interface XRSceneHit {
  panelId: string;
  /** `data-agent-id` of the DOM element the ray resolves to (or null). */
  elementId: string | null;
  /** World-space intersection point. */
  world: Vec3;
  /** Panel-local coordinates, −0.5 … +0.5. */
  u: number;
  v: number;
  /** Screen-space point the hit maps to (CSS px). */
  screen: { x: number; y: number };
}

/** The imperative surface the harness drives. */
export interface XRSceneAPI {
  readonly version: number;
  /** Read poses from the IWER emulator (if present) and re-place panels now. */
  sync(): void;
  getHeadPose(): XRDevicePose;
  setHeadPose(pose: XRDevicePose): void;
  getPanels(): XRScenePanelInfo[];
  /** Cast a world ray; nearest panel hit with the resolved DOM element, or null. */
  hitTest(ray: Ray): XRSceneHit | null;
  /** World position of a `data-agent-id` element, derived from its panel + DOM rect. */
  worldPositionOf(elementId: string): Vec3 | null;
  /** Orientation that aims a device at `from` toward `elementId`. */
  aimFor(from: Vec3, elementId: string): Quat | null;
  /** Move a panel by a world delta; dispatches a "move" action. Returns new position. */
  dragPanel(panelId: string, delta: Vec3): Vec3 | null;
  /** Click the DOM element a controller ray resolves to (drives the real handler). */
  pressRay(ray: Ray): XRSceneHit | null;
}

declare global {
  interface Window {
    /** Installed by a mounted {@link XRSpatialScene} — the harness control surface. */
    __elizaXRScene?: XRSceneAPI;
    /** Read by the scene to track the live emulated headset/controller poses. */
    __XREmulator?: {
      getHeadPose?: () => XRDevicePose;
      getControllerPose?: (handedness: "left" | "right") => XRDevicePose | null;
    };
  }
}

const DEFAULT_HEAD: XRDevicePose = {
  position: vec3(0, 1.6, 0),
  orientation: quatIdentity(),
};

/** Internal mutable placement of a panel (world-anchored or head-followed). */
interface PanelRuntime extends XRPanelSpec {
  position: Vec3;
  width: number;
  height: number;
}

export function XRSpatialScene({
  panels,
  head = DEFAULT_HEAD,
  fovY = (Math.PI / 180) * 60,
  pixelsPerMeter = 900,
  arrangeDistance = 2.4,
  onAction,
}: XRSpatialSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const innerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scopeId = useId().replace(/[:]/g, "");

  // Live runtime state lives in refs so the imperative API + rAF can mutate it
  // and re-place panels without a React re-render (the authored content tree is
  // rendered once and stays stable; only transforms change per frame).
  const headRef = useRef<XRDevicePose>(head);
  const placedRef = useRef<Map<string, XRScenePanelInfo>>(new Map());

  // Auto-arrange panels without an explicit position onto a frontal arc.
  const runtime = useMemo<PanelRuntime[]>(() => {
    const n = panels.length;
    return panels.map((p, i) => {
      const width = p.width ?? 1.2;
      const height = p.height ?? 0.9;
      if (p.position) return { ...p, position: p.position, width, height };
      // Spread across a shallow arc centred on −Z, eye height.
      const spread = (Math.PI / 180) * 50; // 50° total
      const angle = n === 1 ? 0 : -spread / 2 + (spread * i) / (n - 1);
      const position = vec3(
        Math.sin(angle) * arrangeDistance,
        DEFAULT_HEAD.position.y,
        DEFAULT_HEAD.position.z - Math.cos(angle) * arrangeDistance,
      );
      return { ...p, position, width, height };
    });
  }, [panels, arrangeDistance]);

  const runtimeRef = useRef<PanelRuntime[]>(runtime);
  runtimeRef.current = runtime;

  // ── Placement (imperative, runs every frame + on sync) ────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function cameraNow(): Camera {
      const rect = container!.getBoundingClientRect();
      return {
        position: headRef.current.position,
        orientation: headRef.current.orientation,
        fovY,
        aspect: rect.width / Math.max(rect.height, 1),
      };
    }

    function worldPoseOf(p: PanelRuntime): {
      position: Vec3;
      orientation: Quat;
    } {
      const cam = headRef.current;
      const position = p.followOffset
        ? {
            x: cam.position.x + rotateVec3(cam.orientation, p.followOffset).x,
            y: cam.position.y + rotateVec3(cam.orientation, p.followOffset).y,
            z: cam.position.z + rotateVec3(cam.orientation, p.followOffset).z,
          }
        : p.position;
      const orientation = billboardOrientation(position, cam.position);
      return { position, orientation };
    }

    function layout(): void {
      const cam = cameraNow();
      const rect = container!.getBoundingClientRect();
      const viewport = { width: rect.width, height: rect.height };
      const placed = placedRef.current;
      placed.clear();
      for (const p of runtimeRef.current) {
        const wrap = wrapRefs.current.get(p.id);
        const inner = innerRefs.current.get(p.id);
        if (!wrap || !inner) continue;
        const { position, orientation } = worldPoseOf(p);
        const proj = projectToScreen(position, cam, viewport);
        const plane: PanelPlane = {
          position,
          orientation,
          width: p.width,
          height: p.height,
        };
        const size = panelScreenSize(plane, cam, viewport);
        const innerW = p.width * pixelsPerMeter;
        const innerH = p.height * pixelsPerMeter;
        const s = size.width / innerW; // uniform scale (= focal / depth / ppm)
        if (proj.visible && s > 0 && Number.isFinite(s)) {
          wrap.style.display = "block";
          wrap.style.left = `${proj.x - size.width / 2}px`;
          wrap.style.top = `${proj.y - size.height / 2}px`;
          wrap.style.width = `${size.width}px`;
          wrap.style.height = `${size.height}px`;
          wrap.style.zIndex = String(
            Math.max(0, Math.round(100000 - size.depth * 1000)),
          );
          inner.style.width = `${innerW}px`;
          inner.style.height = `${innerH}px`;
          inner.style.transform = `scale(${s})`;
        } else {
          wrap.style.display = "none";
        }
        // Record viewport-absolute rect from the live DOM (authoritative for hits).
        const r = wrap.getBoundingClientRect();
        placed.set(p.id, {
          id: p.id,
          position,
          orientation,
          width: p.width,
          height: p.height,
          screenRect: {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
          },
          depth: size.depth,
          visible: proj.visible,
        });
      }
    }

    function pullPoses(): void {
      const live = window.__XREmulator?.getHeadPose?.();
      if (live) headRef.current = live;
    }

    // ── Imperative API ──────────────────────────────────────────────────────
    function panesAsPlanes(): { id: string; plane: PanelPlane }[] {
      const out: { id: string; plane: PanelPlane }[] = [];
      for (const info of placedRef.current.values()) {
        if (!info.visible) continue;
        out.push({
          id: info.id,
          plane: {
            position: info.position,
            orientation: info.orientation,
            width: info.width,
            height: info.height,
          },
        });
      }
      return out;
    }

    function elementIdAt(
      panelId: string,
      u: number,
      v: number,
    ): {
      elementId: string | null;
      screen: { x: number; y: number };
    } {
      const wrap = wrapRefs.current.get(panelId);
      if (!wrap) return { elementId: null, screen: { x: 0, y: 0 } };
      const r = wrap.getBoundingClientRect();
      const x = r.left + (u + 0.5) * r.width;
      const y = r.top + (0.5 - v) * r.height;
      const el = document.elementFromPoint(x, y);
      const tagged = el?.closest("[data-agent-id]") as HTMLElement | null;
      return {
        elementId: tagged?.dataset.agentId ?? (el?.id || null),
        screen: { x, y },
      };
    }

    function hitTest(ray: Ray): XRSceneHit | null {
      const entries = panesAsPlanes();
      const planes = entries.map((e) => e.plane);
      const best = nearestPanelHit(ray, planes);
      if (!best) return null;
      const entry = entries[best.index];
      const { elementId, screen } = elementIdAt(
        entry.id,
        best.hit.u,
        best.hit.v,
      );
      return {
        panelId: entry.id,
        elementId,
        world: best.hit.world,
        u: best.hit.u,
        v: best.hit.v,
        screen,
      };
    }

    const api: XRSceneAPI = {
      version: 1,
      sync() {
        pullPoses();
        layout();
      },
      getHeadPose: () => headRef.current,
      setHeadPose(pose) {
        headRef.current = pose;
        layout();
      },
      getPanels() {
        layout();
        return Array.from(placedRef.current.values());
      },
      hitTest(ray) {
        layout();
        return hitTest(ray);
      },
      worldPositionOf(elementId) {
        layout();
        const el = (document.querySelector(
          `[data-agent-id="${cssEscape(elementId)}"]`,
        ) ?? document.getElementById(elementId)) as HTMLElement | null;
        if (!el) return null;
        // Which panel owns it?
        let panelId: string | null = null;
        for (const [id, wrap] of wrapRefs.current) {
          if (wrap.contains(el)) {
            panelId = id;
            break;
          }
        }
        if (!panelId) return null;
        const info = placedRef.current.get(panelId);
        const wrap = wrapRefs.current.get(panelId);
        if (!info || !wrap) return null;
        const er = el.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        const u = (er.left + er.width / 2 - wr.left) / wr.width - 0.5;
        const v = 0.5 - (er.top + er.height / 2 - wr.top) / wr.height;
        return panelLocalToWorld(
          {
            position: info.position,
            orientation: info.orientation,
            width: info.width,
            height: info.height,
          },
          u,
          v,
        );
      },
      aimFor(from, elementId) {
        const world = this.worldPositionOf(elementId);
        return world ? quatLookAt(from, world) : null;
      },
      dragPanel(panelId, delta) {
        const p = runtimeRef.current.find((x) => x.id === panelId);
        if (!p) return null;
        p.position = {
          x: p.position.x + delta.x,
          y: p.position.y + delta.y,
          z: p.position.z + delta.z,
        };
        layout();
        onAction?.({
          type: "move",
          agentId: panelId,
          position: { ...p.position },
        });
        return { ...p.position };
      },
      pressRay(ray) {
        const hit = hitTest(ray);
        if (hit?.elementId) {
          const el = document.elementFromPoint(hit.screen.x, hit.screen.y);
          (el as HTMLElement | null)?.click();
        }
        return hit;
      },
    };

    window.__elizaXRScene = api;

    // Live follow loop (browser only — jsdom/SSR render the placement once).
    const hasRaf = typeof requestAnimationFrame === "function";
    let raf = 0;
    const tick = () => {
      pullPoses();
      layout();
      raf = requestAnimationFrame(tick);
    };
    layout();
    if (hasRaf) raf = requestAnimationFrame(tick);

    return () => {
      if (hasRaf) cancelAnimationFrame(raf);
      if (window.__elizaXRScene === api) delete window.__elizaXRScene;
    };
  }, [fovY, pixelsPerMeter, onAction]);

  const containerStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    background:
      "radial-gradient(circle at 50% 35%, #1a1a22 0%, #0b0b0f 70%, #050507 100%)",
    perspective: "1200px",
  };

  return (
    <div
      ref={containerRef}
      data-xr-scene={scopeId}
      data-spatial-surface="xr-scene"
      style={containerStyle}
    >
      {runtime.map((p) => (
        <div
          key={p.id}
          ref={(el) => {
            if (el) wrapRefs.current.set(p.id, el);
            else wrapRefs.current.delete(p.id);
          }}
          data-xr-panel={p.id}
          style={{
            position: "absolute",
            overflow: "hidden",
            borderRadius: "14px",
            boxShadow: "0 8px 40px rgba(0,0,0,0.55)",
            border: "1px solid rgba(255,255,255,0.08)",
            display: "none",
            willChange: "left, top, width, height",
          }}
        >
          <div
            ref={(el) => {
              if (el) innerRefs.current.set(p.id, el);
              else innerRefs.current.delete(p.id);
            }}
            style={{
              transformOrigin: "0 0",
              background: "var(--background, #131319)",
              boxSizing: "border-box",
              padding: "16px",
            }}
          >
            <SpatialSurface modality="xr" onAction={onAction}>
              {p.content}
            </SpatialSurface>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Minimal CSS.escape fallback (jsdom/headless safe) for attribute selectors. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\\]]/g, "\\$&");
}
