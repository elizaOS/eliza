// odysseus canvas background effects (static/js/theme.js _CANVAS_PATTERNS).
// A <canvas> behind the shell content (z-index:-1) running the active pattern's
// animation. Ported faithfully so far: "sparkles" (twinkling 4-point stars);
// the others (synapse/rain/constellations/perlin/petals/embers) follow the same
// init+RAF shape and slot into ANIMATIONS as they're ported.

import { type ReactNode, useEffect, useRef } from "react";

type CanvasPattern =
  | "sparkles"
  | "petals"
  | "rain"
  | "constellations"
  | "embers"
  | "synapse"
  | "perlin";
const ANIMATIONS: Record<
  CanvasPattern,
  (canvas: HTMLCanvasElement) => () => void
> = {
  sparkles: runSparkles,
  petals: runPetals,
  rain: runRain,
  constellations: runConstellations,
  embers: runEmbers,
  synapse: runSynapse,
  perlin: runPerlin,
};

function hexRgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  if (h.length < 6) return `rgba(156,222,242,${a})`;
  const n = Number.parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Value-noise helpers ported from odysseus theme.js (_bgNoise2d / _bgSmoothNoise).
function bgNoise2d(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}
function bgSmoothNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = bgNoise2d(ix, iy);
  const b = bgNoise2d(ix + 1, iy);
  const cc = bgNoise2d(ix, iy + 1);
  const d = bgNoise2d(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * ux + (cc - a) * uy + (a - b - cc + d) * ux * uy;
}

function effectColor(canvas: HTMLCanvasElement): string {
  const s = getComputedStyle(canvas);
  return (
    s.getPropertyValue("--bg-effect-color").trim() ||
    s.getPropertyValue("--fg").trim() ||
    "#9cdef2"
  );
}

// getComputedStyle forces a style recalc, so reading the theme color on every
// requestAnimationFrame frame (~60x/sec) is wasteful for a decorative layer.
// odysseus only changes --bg-effect-color when the theme/color-picker changes,
// not per frame. We therefore re-resolve on a throttled cadence (and a manual
// refresh fires on resize, which already runs on layout changes) so a live
// color-picker drag still updates within a few frames without the recalc cost.
const COLOR_REFRESH_FRAMES = 30;
function makeColorReader(canvas: HTMLCanvasElement): {
  read: () => string;
  refresh: () => void;
} {
  let cached = effectColor(canvas);
  let frames = 0;
  return {
    read() {
      if (++frames >= COLOR_REFRESH_FRAMES) {
        frames = 0;
        cached = effectColor(canvas);
      }
      return cached;
    },
    refresh() {
      frames = 0;
      cached = effectColor(canvas);
    },
  };
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
  const color = makeColorReader(canvas);
  const resize = () => {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    color.refresh();
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
    const c = color.read();
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

// Verbatim port of odysseus theme.js _initPetals — gentle falling petals.
function runPetals(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  const petals: {
    x: number;
    y: number;
    size: number;
    rot: number;
    vr: number;
    vy: number;
    drift: number;
    driftSpeed: number;
    wobble: number;
  }[] = [];
  const make = () => ({
    x: Math.random() * w,
    y: -10 - Math.random() * 40,
    size: 3 + Math.random() * 5,
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.03,
    vy: 0.3 + Math.random() * 0.6,
    drift: Math.random() * Math.PI * 2,
    driftSpeed: 0.008 + Math.random() * 0.012,
    wobble: 0.3 + Math.random() * 0.8,
  });
  const color = makeColorReader(canvas);
  const resize = () => {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    color.refresh();
    if (petals.length === 0)
      for (let i = 0; i < 30; i++) {
        const p = make();
        p.y = Math.random() * h;
        petals.push(p);
      }
  };
  resize();
  window.addEventListener("resize", resize);
  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, w, h);
    const c = color.read();
    for (const p of petals) {
      p.y += p.vy;
      p.rot += p.vr;
      p.drift += p.driftSpeed;
      p.x += Math.sin(p.drift) * p.wobble;
      if (p.y > h + 15) Object.assign(p, make());
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = c;
      ctx.globalAlpha = 0.2;
      ctx.beginPath();
      ctx.ellipse(
        -p.size * 0.2,
        0,
        p.size * 0.6,
        p.size * 0.3,
        0.3,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.ellipse(
        p.size * 0.2,
        0,
        p.size * 0.6,
        p.size * 0.3,
        -0.3,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  };
  draw();
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}

// Verbatim port of odysseus theme.js _initRain — falling gradient streaks.
function runRain(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  const drops: {
    x: number;
    y: number;
    len: number;
    speed: number;
    alpha: number;
  }[] = [];
  const MAX_DROPS = 130;
  const color = makeColorReader(canvas);
  const resize = () => {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    color.refresh();
  };
  resize();
  window.addEventListener("resize", resize);
  const spawn = () => {
    const len = 20 + Math.random() * 40;
    drops.push({
      x: Math.random() * w,
      y: -len,
      len,
      speed: 4 + Math.random() * 8,
      alpha: 0.32 + Math.random() * 0.28,
    });
  };
  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, w, h);
    const c = color.read();
    if (drops.length < MAX_DROPS && Math.random() < 0.6) spawn();
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.y += d.speed;
      if (d.y > h + d.len) {
        drops.splice(i, 1);
        continue;
      }
      const grad = ctx.createLinearGradient(d.x, d.y - d.len, d.x, d.y);
      grad.addColorStop(0, "transparent");
      grad.addColorStop(1, c);
      ctx.strokeStyle = grad;
      ctx.globalAlpha = d.alpha;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y - d.len);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  draw();
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}

// Verbatim port of odysseus theme.js _initConstellations — drifting stars
// with proximity-connecting lines + twinkle.
function runConstellations(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  const STAR_COUNT = 50;
  const CONNECT_DIST = 120;
  let stars: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    r: number;
    phase: number;
  }[] = [];
  const initStars = () => {
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++)
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.15,
        vy: (Math.random() - 0.5) * 0.15,
        r: 0.8 + Math.random() * 0.8,
        phase: Math.random() * Math.PI * 2,
      });
  };
  const color = makeColorReader(canvas);
  const resize = () => {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    color.refresh();
    if (stars.length === 0) initStars();
  };
  resize();
  const onResize = () => {
    resize();
    initStars();
  };
  window.addEventListener("resize", onResize);
  let t = 0;
  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    t += 0.01;
    ctx.clearRect(0, 0, w, h);
    const c = color.read();
    for (const s of stars) {
      s.x += s.vx;
      s.y += s.vy;
      if (s.x < 0) s.x = w;
      if (s.x > w) s.x = 0;
      if (s.y < 0) s.y = h;
      if (s.y > h) s.y = 0;
    }
    ctx.strokeStyle = c;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < stars.length; i++)
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x;
        const dy = stars[i].y - stars[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CONNECT_DIST) {
          ctx.globalAlpha = (1 - dist / CONNECT_DIST) * 0.15;
          ctx.beginPath();
          ctx.moveTo(stars[i].x, stars[i].y);
          ctx.lineTo(stars[j].x, stars[j].y);
          ctx.stroke();
        }
      }
    ctx.fillStyle = c;
    for (const s of stars) {
      const twinkle = 0.5 + 0.5 * Math.sin(t * 2 + s.phase);
      ctx.globalAlpha = 0.15 + twinkle * 0.25;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  draw();
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
  };
}

// Verbatim port of odysseus theme.js _initEmbers — rising glowing embers with
// sparks + occasional ground bursts (destination-out fade + lighter compositing).
function runEmbers(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  const embers: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    r: number;
    life: number;
    maxLife: number;
    wobble: number;
    spark: boolean;
  }[] = [];
  const make = () => ({
    x: Math.random() * w,
    y: h + Math.random() * 40,
    vx: (Math.random() - 0.5) * 0.3,
    vy: -0.3 - Math.random() * 0.8,
    r: 0.3 + Math.random() * 0.6,
    life: 0,
    maxLife: 220 + Math.random() * 220,
    wobble: Math.random() * Math.PI * 2,
    spark: false,
  });
  const colorReader = makeColorReader(canvas);
  const resize = () => {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    colorReader.refresh();
    if (embers.length === 0)
      for (let i = 0; i < 60; i++) {
        const e = make();
        e.y = Math.random() * h;
        e.life = Math.random() * e.maxLife;
        embers.push(e);
      }
  };
  resize();
  window.addEventListener("resize", resize);
  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    const color = colorReader.read();
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      e.wobble += 0.03;
      e.x += e.vx + Math.sin(e.wobble) * 0.5;
      e.y += e.vy;
      e.life++;
      if (e.life > e.maxLife || e.y < -20) {
        embers.splice(i, 1);
        if (embers.length < 70) embers.push(make());
        continue;
      }
      if (!e.spark && Math.random() < 0.003) e.spark = true;
      const lr = e.life / e.maxLife;
      const fade = Math.min(1, Math.min(lr * 4, (1 - lr) * 3));
      const r = e.r * (e.spark ? 2.4 : 1);
      const a = (e.spark ? 0.9 : 0.55) * fade;
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r * 4);
      g.addColorStop(0, hexRgba(color, a));
      g.addColorStop(0.4, hexRgba(color, a * 0.3));
      g.addColorStop(1, hexRgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(e.x - r * 4, e.y - r * 4, r * 8, r * 8);
      ctx.fillStyle = hexRgba("#ffffff", a * 0.6);
      ctx.beginPath();
      ctx.arc(e.x, e.y, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      e.spark = false;
    }
    if (Math.random() < 0.015) {
      const bx = Math.random() * w;
      for (let i = 0; i < 5; i++) {
        const e = make();
        e.x = bx + (Math.random() - 0.5) * 40;
        e.y = h - 10;
        e.vy *= 1.5;
        embers.push(e);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  };
  draw();
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}

// Verbatim port of odysseus theme.js _initSynapse — grid pulses with trails.
function runSynapse(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const GRID = 24;
  const MAX_PULSES = 20;
  const SPEED_MIN = 2;
  const SPEED_MAX = 22;
  const TRAIL_LEN = 12;
  let w = 0;
  let h = 0;
  let cols = 0;
  let rows = 0;
  const pulses: { x: number; y: number; dx: number; dy: number }[] = [];
  const color = makeColorReader(canvas);
  const resize = () => {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    color.refresh();
    cols = Math.ceil(w / GRID);
    rows = Math.ceil(h / GRID);
  };
  resize();
  window.addEventListener("resize", resize);
  const spawn = () => {
    const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
    if (Math.random() > 0.5)
      pulses.push({
        x: -TRAIL_LEN,
        y: Math.floor(Math.random() * (rows + 1)) * GRID,
        dx: speed,
        dy: 0,
      });
    else
      pulses.push({
        x: Math.floor(Math.random() * (cols + 1)) * GRID,
        y: -TRAIL_LEN,
        dx: 0,
        dy: speed,
      });
  };
  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, w, h);
    const c = color.read();
    if (pulses.length < MAX_PULSES && Math.random() < 0.12) spawn();
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.x += p.dx;
      p.y += p.dy;
      if (p.x > w + TRAIL_LEN || p.y > h + TRAIL_LEN) {
        pulses.splice(i, 1);
        continue;
      }
      const tx = p.x - (p.dx > 0 ? TRAIL_LEN : 0);
      const ty = p.y - (p.dy > 0 ? TRAIL_LEN : 0);
      const grad = ctx.createLinearGradient(tx, ty, p.x, p.y);
      grad.addColorStop(0, "transparent");
      grad.addColorStop(1, c);
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  draw();
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}

// Verbatim port of odysseus theme.js _initPerlinFlow — noise-driven particle streams.
function runPerlin(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  let t = 0;
  const particles: { x: number; y: number; life: number }[] = [];
  const color = makeColorReader(canvas);
  // Cache the parsed --bg fade rgba and only re-parse when the bg string
  // actually changes — odysseus's _initPerlinFlow does exactly this
  // (_cachedBg / _fadeStyle) so the per-frame path never touches the parser.
  let cachedBg = "";
  let fadeStyle = "rgba(40,44,52,0.02)";
  let bgFrames = 0;
  const fade = () => {
    if (++bgFrames < COLOR_REFRESH_FRAMES && cachedBg) return fadeStyle;
    bgFrames = 0;
    const bg =
      getComputedStyle(canvas).getPropertyValue("--bg").trim() || "#282c34";
    if (bg === cachedBg) return fadeStyle;
    cachedBg = bg;
    const hh = bg.replace("#", "");
    if (hh.length < 6) {
      fadeStyle = "rgba(40,44,52,0.02)";
    } else {
      const n = Number.parseInt(hh.slice(0, 6), 16);
      fadeStyle = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.02)`;
    }
    return fadeStyle;
  };
  const resize = () => {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    color.refresh();
    bgFrames = COLOR_REFRESH_FRAMES;
    if (particles.length === 0)
      for (let i = 0; i < 200; i++)
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          life: Math.random(),
        });
  };
  resize();
  window.addEventListener("resize", resize);
  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    ctx.fillStyle = fade();
    ctx.fillRect(0, 0, w, h);
    const c = color.read();
    for (const p of particles) {
      const angle =
        bgSmoothNoise(p.x * 0.004 + t * 0.0008, p.y * 0.004 + 100) *
        Math.PI *
        6;
      const speed = 1 + bgSmoothNoise(p.x * 0.003, p.y * 0.003 + 50) * 1.5;
      p.x += Math.cos(angle) * speed;
      p.y += Math.sin(angle) * speed;
      p.life -= 0.001;
      if (p.life <= 0 || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
        p.x = Math.random() * w;
        p.y = Math.random() * h;
        p.life = 1;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.globalAlpha = p.life * 0.15;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    t++;
  };
  draw();
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}

export const CANVAS_BG_PATTERNS: CanvasPattern[] = [
  "sparkles",
  "petals",
  "rain",
  "constellations",
  "embers",
  "synapse",
  "perlin",
];

export function BgEffect({ pattern }: { pattern: string }): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !Object.hasOwn(ANIMATIONS, pattern)) return;
    return ANIMATIONS[pattern as CanvasPattern](canvas);
  }, [pattern]);

  if (!Object.hasOwn(ANIMATIONS, pattern)) return null;
  // Decorative, pointer-events:none layer. tabIndex={-1} keeps it out of the
  // tab order so aria-hidden is valid (odysseus hides it from assistive tech
  // so screen readers don't announce an empty canvas).
  return (
    <canvas
      ref={ref}
      className="od-bg-canvas"
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}
