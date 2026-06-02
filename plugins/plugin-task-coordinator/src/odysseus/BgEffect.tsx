// odysseus canvas background effects (static/js/theme.js _CANVAS_PATTERNS).
// A <canvas> behind the shell content (z-index:-1) running the active pattern's
// animation. Ported faithfully so far: "sparkles" (twinkling 4-point stars);
// the others (synapse/rain/constellations/perlin/petals/embers) follow the same
// init+RAF shape and slot into ANIMATIONS as they're ported.

import { type ReactNode, useEffect, useRef } from "react";

type CanvasPattern = "sparkles";
const ANIMATIONS: Record<
  CanvasPattern,
  (canvas: HTMLCanvasElement) => () => void
> = {
  sparkles: runSparkles,
};

function effectColor(canvas: HTMLCanvasElement): string {
  const s = getComputedStyle(canvas);
  return (
    s.getPropertyValue("--bg-effect-color").trim() ||
    s.getPropertyValue("--fg").trim() ||
    "#9cdef2"
  );
}

// Verbatim port of odysseus theme.js _initSparkles.
function runSparkles(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  const sparkles: {
    x: number;
    y: number;
    size: number;
    phase: number;
    speed: number;
    life: number;
  }[] = [];
  const makeSpark = () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    size: 2 + Math.random() * 5,
    phase: Math.random() * Math.PI * 2,
    speed: 0.015 + Math.random() * 0.03,
    life: 0.5 + Math.random() * 0.5,
  });
  const resize = () => {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sparkles.length === 0)
      for (let i = 0; i < 35; i++) sparkles.push(makeSpark());
  };
  resize();
  window.addEventListener("resize", resize);
  const drawStar = (
    x: number,
    y: number,
    r: number,
    c: string,
    alpha: number,
  ) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = c;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(r * 0.15, -r * 0.15, r, 0);
    ctx.quadraticCurveTo(r * 0.15, r * 0.15, 0, r);
    ctx.quadraticCurveTo(-r * 0.15, r * 0.15, -r, 0);
    ctx.quadraticCurveTo(-r * 0.15, -r * 0.15, 0, -r);
    ctx.fill();
    ctx.restore();
  };
  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, w, h);
    const c = effectColor(canvas);
    for (const s of sparkles) {
      s.phase += s.speed;
      const twinkle = Math.sin(s.phase);
      const alpha = Math.max(0, twinkle) * 0.25 * s.life;
      const scale = 0.5 + Math.max(0, twinkle) * 0.5;
      if (alpha > 0.01) drawStar(s.x, s.y, s.size * scale, c, alpha);
      if (s.phase > Math.PI * 6) Object.assign(s, makeSpark());
    }
  };
  draw();
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}

export const CANVAS_BG_PATTERNS: CanvasPattern[] = ["sparkles"];

export function BgEffect({ pattern }: { pattern: string }): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !(pattern in ANIMATIONS)) return;
    return ANIMATIONS[pattern as CanvasPattern](canvas);
  }, [pattern]);

  if (!(pattern in ANIMATIONS)) return null;
  return <canvas ref={ref} className="od-bg-canvas" aria-hidden="true" />;
}
