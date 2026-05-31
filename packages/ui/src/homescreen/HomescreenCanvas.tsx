import type * as React from "react";
import { useEffect, useRef } from "react";
import type * as THREE from "three";
import {
  type FrequencyAnalyser,
  sampleFrequencyLevels,
  summarizeLevels,
} from "../components/voice/VoiceWaveform";
import {
  createPerfState,
  type PerfState,
  perfLabel,
  perfTick,
} from "./scene-perf";
import { registerBuiltinPresets } from "./scene-presets";
import {
  createSceneInputs,
  resolveSceneFactoryOrDefault,
} from "./scene-runtime";
import type {
  HomescreenPhase,
  HomescreenScene,
  SceneInputs,
  SceneInstance,
  SceneRenderContext,
} from "./scene-types";

registerBuiltinPresets();

const BANDS = 32;

export interface HomescreenCanvasProps {
  /** The scene document to render. Swapping it remounts the background. */
  scene: HomescreenScene;
  /** Live audio source (user mic or assistant TTS), or null when silent. */
  analyser?: FrequencyAnalyser | null;
  phase?: HomescreenPhase;
  userText?: string;
  assistantText?: string;
  /** Notified with a human-readable perf label (e.g. "58 fps · 80% detail"). */
  onPerfLabel?: (label: string, state: PerfState) => void;
  className?: string;
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
  onPerfLabel,
  className,
}: HomescreenCanvasProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Latest live props, read by the frame loop without re-subscribing it.
  const liveRef = useRef({ analyser, phase, userText, assistantText });
  liveRef.current = { analyser, phase, userText, assistantText };

  // Pointer position in normalized device coords (-1..1).
  const pointerRef = useRef({ x: 0, y: 0, down: false });

  // The active scene document, read by the swap effect.
  const sceneRef = useRef(scene);

  // A setter the swap effect wires up once the engine is mounted.
  const setSceneRef = useRef<((s: HomescreenScene) => void) | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once renderer; live props are read through refs.
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
        };
        const { factory } = resolveSceneFactoryOrDefault(doc.background);
        const instance = factory ? factory(ctx) : { update() {}, dispose() {} };
        return Object.assign(instance, { __scene: renderScene });
      };

      let current = mountScene(sceneRef.current);
      let currentScene = (current as SceneInstance & { __scene: THREE.Scene })
        .__scene;

      setSceneRef.current = (doc: HomescreenScene) => {
        current.dispose();
        current = mountScene(doc);
        currentScene = (current as SceneInstance & { __scene: THREE.Scene })
          .__scene;
      };

      const resize = () => {
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(container);

      let perf: PerfState = createPerfState();
      let last = performance.now();
      let rafId = 0;
      let lastPerfLabel = "";

      const frame = () => {
        if (disposed) return;
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;

        // Refresh live inputs in place (scenes treat as read-only).
        const live = liveRef.current;
        const summary = summarizeLevels(
          sampleFrequencyLevels(live.analyser, BANDS),
        );
        const isUser = live.phase === "listening";
        inputs.audioUser = isUser ? summary.energy : 0;
        inputs.audioAssistant = live.phase === "speaking" ? summary.energy : 0;
        inputs.energy = Math.max(inputs.audioUser, inputs.audioAssistant);
        inputs.bands = {
          low: summary.low,
          mid: summary.mid,
          high: summary.high,
        };
        inputs.pointer = { ...pointerRef.current };
        inputs.phase = live.phase;
        inputs.userText = live.userText;
        inputs.assistantText = live.assistantText;
        inputs.time += dt;

        current.update(dt, inputs.time);

        const tick = perfTick(perf, dt);
        perf = tick.state;
        if (tick.retarget !== null && current.optimize) {
          current.optimize(tick.retarget);
        }
        if (onPerfLabel) {
          const label = perfLabel(perf);
          if (label !== lastPerfLabel) {
            lastPerfLabel = label;
            onPerfLabel(label, perf);
          }
        }

        renderer.render(currentScene, camera);
        rafId = requestAnimationFrame(frame);
      };
      rafId = requestAnimationFrame(frame);

      cleanup = () => {
        cancelAnimationFrame(rafId);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply scene-document changes without remounting the renderer.
  useEffect(() => {
    sceneRef.current = scene;
    setSceneRef.current?.(scene);
  }, [scene]);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    pointerRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointerRef.current.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  };

  return (
    <div
      ref={containerRef}
      data-testid="homescreen-canvas"
      className={className}
      style={{ position: "absolute", inset: 0 }}
      onPointerMove={onPointerMove}
      onPointerDown={() => {
        pointerRef.current.down = true;
      }}
      onPointerUp={() => {
        pointerRef.current.down = false;
      }}
    />
  );
}
