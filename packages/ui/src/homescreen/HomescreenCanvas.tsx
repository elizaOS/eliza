import type * as React from "react";
import { useEffect, useRef } from "react";
import type * as THREE from "three";
import {
  type FrequencyAnalyser,
  sampleFrequencyLevels,
  summarizeLevels,
} from "../components/voice/VoiceWaveform";
import { createPerfState, type PerfState, perfTick } from "./scene-perf";
import { registerBuiltinPresets } from "./scene-presets";
import {
  createSceneInputs,
  createSceneOutputs,
  resolveSceneFactoryOrDefault,
} from "./scene-runtime";
import type {
  HomescreenPhase,
  HomescreenScene,
  SceneInputs,
  SceneInstance,
  SceneOutputs,
  SceneRenderContext,
} from "./scene-types";

registerBuiltinPresets();

const BANDS = 32;

/** Projected on-screen position of the orb, forwarded to the React layer. */
export type OrbAnchor = NonNullable<SceneOutputs["orbAnchor"]>;

/** Emit a new anchor only when it shifts more than this (canvas fractions). */
const ANCHOR_EPSILON = 0.002;

export interface HomescreenCanvasProps {
  /** The scene document to render. Swapping it remounts the background. */
  scene: HomescreenScene;
  /** Live audio source (user mic or assistant TTS), or null when silent. */
  analyser?: FrequencyAnalyser | null;
  phase?: HomescreenPhase;
  userText?: string;
  assistantText?: string;
  /**
   * Notified when the orb's projected screen position changes (or becomes null
   * for scenes without an orb), so the host can anchor its hit target to the
   * real rendered orb instead of a hardcoded guess.
   */
  onOrbAnchor?: (anchor: OrbAnchor | null) => void;
  className?: string;
}

/** Whether two orb anchors differ enough to be worth re-emitting to React. */
function anchorChanged(
  a: SceneOutputs["orbAnchor"],
  b: SceneOutputs["orbAnchor"],
): boolean {
  if (a === null || b === null) return a !== b;
  return (
    Math.abs(a.x - b.x) > ANCHOR_EPSILON ||
    Math.abs(a.y - b.y) > ANCHOR_EPSILON ||
    Math.abs(a.r - b.r) > ANCHOR_EPSILON
  );
}

/** Read through a function boundary so scene-side mutation is not narrowed away. */
function readOrbAnchor(outputs: SceneOutputs): SceneOutputs["orbAnchor"] {
  return outputs.orbAnchor;
}

/** True when a WebGL2 context is obtainable (false in jsdom / SSR). */
function webglAvailable(): boolean {
  if (typeof document === "undefined") return false;
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

/**
 * The live homescreen background. Owns the WebGL renderer, scene, camera, and
 * frame loop; resolves the scene document's background to a {@link SceneInstance}
 * and drives it with live inputs. The pure parts it leans on — factory
 * resolution, the perf governor, the input contract — are unit-tested
 * separately; this component is the imperative three.js shell around them.
 */
export function HomescreenCanvas({
  scene,
  analyser,
  phase = "idle",
  userText = "",
  assistantText = "",
  onOrbAnchor,
  className,
}: HomescreenCanvasProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Latest live props, read by the frame loop without re-subscribing it.
  const liveRef = useRef({
    analyser,
    phase,
    userText,
    assistantText,
    onOrbAnchor,
  });
  liveRef.current = { analyser, phase, userText, assistantText, onOrbAnchor };

  // Pointer position in normalized device coords (-1..1).
  const pointerRef = useRef({ x: 0, y: 0, down: false });

  // Track pointer globally so drag-starting on overlaid elements (e.g. the
  // orb hit-target button) still reaches the scene inputs.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      pointerRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerRef.current.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    };
    const down = () => {
      pointerRef.current.down = true;
    };
    const up = () => {
      pointerRef.current.down = false;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
    };
  }, []);

  // The active scene document, read by the swap effect.
  const sceneRef = useRef(scene);

  // A setter the swap effect wires up once the engine is mounted.
  const setSceneRef = useRef<((s: HomescreenScene) => void) | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !webglAvailable()) return;

    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      const T = (await import("three")) as typeof THREE;
      if (disposed || !containerRef.current) return;

      const renderer = new T.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const el = renderer.domElement;
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.display = "block";
      container.appendChild(el);

      const camera = new T.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.z = 3.2;

      const inputs = createSceneInputs();
      const outputs = createSceneOutputs();
      // Last anchor emitted to the host, for change detection.
      let lastAnchor: SceneOutputs["orbAnchor"] = null;

      const mountScene = (doc: HomescreenScene): SceneInstance => {
        const renderScene = new T.Scene();
        const ctx: SceneRenderContext = {
          three: T,
          scene: renderScene,
          camera,
          renderer,
          size: { width: 0, height: 0, dpr: renderer.getPixelRatio() },
          theme: doc.theme,
          inputs: inputs as Readonly<SceneInputs>,
          outputs,
        };
        const { factory } = resolveSceneFactoryOrDefault(doc.background);
        const instance = factory ? factory(ctx) : { update() {}, dispose() {} };
        return Object.assign(instance, { __scene: renderScene });
      };

      let current = mountScene(sceneRef.current);
      let currentScene = (current as SceneInstance & { __scene: THREE.Scene })
        .__scene;

      let perf: PerfState = createPerfState();
      let last = performance.now();
      let rafId = 0;

      // Honor prefers-reduced-motion: hold the crystal ball as a single static
      // frame instead of a continuous pulse/ripple loop. Mirrors the rest of
      // the background system (CloudVideoBackground, slow-clouds) and satisfies
      // WCAG 2.3.3 — the sphere stays visible, it just stops animating. Toggling
      // the OS setting is honored live.
      const reducedMotion =
        typeof window.matchMedia === "function"
          ? window.matchMedia("(prefers-reduced-motion: reduce)")
          : null;

      // Draw exactly one frame. With `advance: false` (the static repaint used
      // for reduced-motion, resize, and scene swaps) the clock and perf governor
      // do not tick, so the scene renders frozen at its current state.
      const renderFrame = (advance: boolean) => {
        const now = performance.now();
        const dt = advance ? (now - last) / 1000 : 0;
        last = now;

        // Refresh live inputs in place (scenes treat as read-only). Mutating the
        // band/pointer sub-objects rather than reallocating them avoids per-frame
        // GC churn in this hot loop and keeps any scene that captured the
        // reference once reading live values.
        const live = liveRef.current;
        if (live.analyser) {
          const summary = summarizeLevels(
            sampleFrequencyLevels(live.analyser, BANDS),
          );
          inputs.audioUser = live.phase === "listening" ? summary.energy : 0;
          inputs.audioAssistant =
            live.phase === "speaking" ? summary.energy : 0;
          inputs.bands.low = summary.low;
          inputs.bands.mid = summary.mid;
          inputs.bands.high = summary.high;
        } else {
          // No audio source (onboarding backdrop, idle home): skip the FFT
          // sampling allocations entirely — every band is silent.
          inputs.audioUser = 0;
          inputs.audioAssistant = 0;
          inputs.bands.low = 0;
          inputs.bands.mid = 0;
          inputs.bands.high = 0;
        }
        inputs.energy = Math.max(inputs.audioUser, inputs.audioAssistant);
        inputs.pointer.x = pointerRef.current.x;
        inputs.pointer.y = pointerRef.current.y;
        inputs.pointer.down = pointerRef.current.down;
        inputs.phase = live.phase;
        inputs.userText = live.userText;
        inputs.assistantText = live.assistantText;
        inputs.time += dt;

        // Cleared each frame so a scene that doesn't write an anchor (no orb)
        // leaves it null rather than stale.
        outputs.orbAnchor = null;
        current.update(dt, inputs.time);

        // Forward the orb anchor to the host when it meaningfully changed.
        const next = readOrbAnchor(outputs);
        const emit = liveRef.current.onOrbAnchor;
        if (emit && anchorChanged(lastAnchor, next)) {
          const copy =
            next === null ? null : { x: next.x, y: next.y, r: next.r };
          lastAnchor = copy;
          emit(copy);
        }

        if (advance) {
          const tick = perfTick(perf, dt);
          perf = tick.state;
          if (tick.retarget !== null && current.optimize) {
            current.optimize(tick.retarget);
          }
        }

        renderer.render(currentScene, camera);
      };

      const frame = () => {
        if (disposed) return;
        renderFrame(true);
        rafId = requestAnimationFrame(frame);
      };

      const startLoop = () => {
        if (rafId || disposed) return;
        last = performance.now();
        rafId = requestAnimationFrame(frame);
      };

      const stopLoop = () => {
        if (!rafId) return;
        cancelAnimationFrame(rafId);
        rafId = 0;
      };

      // Animate unless the user asked for reduced motion, in which case draw a
      // single static frame and hold there.
      const applyMotionPreference = () => {
        if (reducedMotion?.matches) {
          stopLoop();
          renderFrame(false);
        } else {
          startLoop();
        }
      };

      setSceneRef.current = (doc: HomescreenScene) => {
        current.dispose();
        current = mountScene(doc);
        currentScene = (current as SceneInstance & { __scene: THREE.Scene })
          .__scene;
        // A frozen (reduced-motion) surface won't otherwise repaint the swap.
        if (!rafId) renderFrame(false);
      };

      const resize = () => {
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        // Keep the static frame matched to the viewport while frozen.
        if (!rafId) renderFrame(false);
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(container);

      applyMotionPreference();
      reducedMotion?.addEventListener("change", applyMotionPreference);

      // A lost GPU context (sleep/wake, driver reset, too many live contexts)
      // would otherwise leave a permanently black canvas while the loop keeps
      // rendering into a dead context. Pause on loss; rebuild the scene graph —
      // its GPU resources are gone — and resume on restore.
      const onContextLost = (e: Event) => {
        e.preventDefault();
        stopLoop();
      };
      const onContextRestored = () => {
        if (disposed) return;
        current.dispose();
        current = mountScene(sceneRef.current);
        currentScene = (current as SceneInstance & { __scene: THREE.Scene })
          .__scene;
        resize();
        applyMotionPreference();
      };
      el.addEventListener("webglcontextlost", onContextLost);
      el.addEventListener("webglcontextrestored", onContextRestored);

      cleanup = () => {
        stopLoop();
        reducedMotion?.removeEventListener("change", applyMotionPreference);
        el.removeEventListener("webglcontextlost", onContextLost);
        el.removeEventListener("webglcontextrestored", onContextRestored);
        ro.disconnect();
        current.dispose();
        renderer.dispose();
        if (el.parentNode) el.parentNode.removeChild(el);
        setSceneRef.current = null;
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
    // Mount once; scene swaps go through the imperative setter below.
  }, []);

  // Apply scene-document changes without remounting the renderer.
  useEffect(() => {
    sceneRef.current = scene;
    setSceneRef.current?.(scene);
  }, [scene]);

  return (
    <div
      ref={containerRef}
      data-testid="homescreen-canvas"
      className={className}
      style={{ position: "absolute", inset: 0 }}
      onPointerLeave={() => {
        pointerRef.current.down = false;
      }}
    />
  );
}
