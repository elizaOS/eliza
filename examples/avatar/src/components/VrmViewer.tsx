import { useEffect, useRef } from "react";
import { VrmEngine, type VrmEngineState } from "./VrmEngine";

const DEFAULT_VRM_PATH = "/bot.vrm";

export type VrmViewerProps = {
  mouthOpen: number;
  onEngineState?: (state: VrmEngineState) => void;
  onEngineReady?: (engine: VrmEngine) => void;
};

export function VrmViewer(props: VrmViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<VrmEngine | null>(null);
  const mouthOpenRef = useRef<number>(props.mouthOpen);
  const lastStateEmitMsRef = useRef<number>(0);
  const mountedRef = useRef(true);

  // Keep mouthOpen in sync without re-running effect
  mouthOpenRef.current = props.mouthOpen;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Track mount state for async operations
    mountedRef.current = true;

    // Create engine only if we don't have one or it was disposed
    let engine = engineRef.current;
    if (!engine || !engine.isInitialized()) {
      engine = new VrmEngine();
      engineRef.current = engine;
    }

    engine.setup(canvas, () => {
      // Called each frame. Keep mouth open value in sync.
      engine.setMouthOpen(mouthOpenRef.current);

      // Emit status updates at a low rate (avoid re-rendering every frame).
      if (props.onEngineState && mountedRef.current) {
        const now = performance.now();
        if (now - lastStateEmitMsRef.current >= 250) {
          lastStateEmitMsRef.current = now;
          props.onEngineState(engine.getState());
        }
      }
    });

    // Notify parent that engine is ready
    props.onEngineReady?.(engine);

    const resize = () => {
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      engine.resize(rect.width, rect.height);
    };
    resize();
    window.addEventListener("resize", resize);

    // Auto-load default VRM from /public (Vite serves public/ at "/")
    const loadAbortController = new AbortController();

    void (async () => {
      try {
        // Check if still mounted before starting load
        if (!mountedRef.current || loadAbortController.signal.aborted) return;

        await engine.loadVrmFromUrl(DEFAULT_VRM_PATH, "bot.vrm");

        // Check again after async operation completes
        if (!mountedRef.current || loadAbortController.signal.aborted) return;

        props.onEngineState?.(engine.getState());
      } catch (err) {
        // Ignore abort errors, log others
        if (err instanceof Error && err.name === "AbortError") return;
        // If the default VRM is missing or fails to load, user can still load one manually.
        console.warn("Failed to load default VRM:", err);
      }
    })();

    return () => {
      // Mark as unmounted to cancel any pending async operations
      mountedRef.current = false;
      loadAbortController.abort();

      window.removeEventListener("resize", resize);

      // Only dispose if this is a real unmount, not a StrictMode re-render
      // We detect this by checking if we're unmounting shortly after mount
      // In StrictMode, React unmounts and remounts immediately
      // We delay the dispose to allow the remount to reuse the engine
      const engineToDispose = engine;
      setTimeout(() => {
        // If we haven't been remounted (mountedRef would be true again), dispose
        if (!mountedRef.current) {
          engineToDispose.dispose();
          if (engineRef.current === engineToDispose) {
            engineRef.current = null;
          }
        }
      }, 100);
    };
  }, []);

  return <canvas ref={canvasRef} className="vrm-canvas-fullpage" />;
}
