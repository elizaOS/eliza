/**
 * Panel → texture — rasterize panel content into an image the immersive renderer
 * uploads as a textured quad.
 *
 * Why a 2D canvas and not the panel's live DOM: an SVG `<foreignObject>` snapshot
 * of real DOM **cannot** be uploaded to WebGL. Chromium (and WebKit) mark any
 * canvas/image derived from a foreignObject as origin-unclean — `texImage2D`
 * throws `SecurityError: ... may not be loaded` (a deliberate privacy measure
 * against reading rendered HTML through the GPU). Verified empirically in the
 * IWER PoC: a foreignObject rasterization decodes fine but its WebGL upload is
 * rejected, both directly and via an intermediate 2D canvas.
 *
 * So immersive panel content is drawn straight to a 2D canvas (a header + wrapped
 * body lines), which IS origin-clean and uploads cleanly. Rich interactive DOM
 * stays on the CSS `XRSpatialScene` (flat-DOM) path; the headset compositor takes
 * canvas textures. This module is dependency-free and browser-safe.
 */

/** Anything WebGL `texImage2D` accepts as a panel texture source. */
export type PanelTexel =
  | HTMLImageElement
  | HTMLCanvasElement
  | ImageBitmap
  | OffscreenCanvas;

/** The text content of an immersive panel — a header and body lines. */
export interface PanelContent {
  title?: string;
  /** Body lines; each is word-wrapped to the panel width. */
  lines?: string[];
  /** Accent colour (any CSS colour) for the title rule. Default brand orange. */
  accent?: string;
  /** Card background (any CSS colour). Default near-black. */
  background?: string;
  /** Body text colour. Default near-white. */
  foreground?: string;
}

export interface RasterizeOptions {
  /** Output width in device pixels (the panel's design resolution). */
  width: number;
  height: number;
  /** Supersample factor for crisp text in a headset (default 2). */
  pixelRatio?: number;
}

const DEFAULTS = {
  accent: "rgb(255, 88, 0)", // brand orange
  background: "rgb(19, 19, 25)",
  foreground: "rgb(236, 236, 240)",
};

/**
 * Draw a panel's content to an origin-clean 2D canvas ready for WebGL upload.
 * Returns the canvas (a valid {@link PanelTexel}). Throws if a 2D context is
 * unavailable (e.g. jsdom without node-canvas).
 */
export function rasterizePanelToCanvas(
  content: PanelContent,
  opts: RasterizeOptions,
): HTMLCanvasElement {
  const ratio = opts.pixelRatio ?? 2;
  const w = Math.max(1, Math.round(opts.width * ratio));
  const h = Math.max(1, Math.round(opts.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("[panel-texture] no 2d context");

  const pad = Math.round(18 * ratio);
  const bg = content.background ?? DEFAULTS.background;
  const fg = content.foreground ?? DEFAULTS.foreground;
  const accent = content.accent ?? DEFAULTS.accent;

  // Card.
  roundRect(ctx, 0, 0, w, h, Math.round(14 * ratio));
  ctx.fillStyle = bg;
  ctx.fill();

  let y = pad;
  // Title + accent rule.
  if (content.title) {
    const titleSize = Math.round(26 * ratio);
    ctx.fillStyle = fg;
    ctx.font = `600 ${titleSize}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(content.title, pad, y, w - pad * 2);
    y += titleSize + Math.round(8 * ratio);
    ctx.fillStyle = accent;
    ctx.fillRect(pad, y, Math.round(44 * ratio), Math.round(3 * ratio));
    y += Math.round(16 * ratio);
  }

  // Body lines, word-wrapped to the inner width.
  if (content.lines?.length) {
    const bodySize = Math.round(20 * ratio);
    const lineH = Math.round(bodySize * 1.4);
    ctx.fillStyle = fg;
    ctx.font = `400 ${bodySize}px system-ui, -apple-system, sans-serif`;
    const inner = w - pad * 2;
    for (const raw of content.lines) {
      for (const line of wrapText(
        raw,
        inner,
        (s) => ctx.measureText(s).width,
      )) {
        if (y + lineH > h - pad) return canvas; // clip to the card
        ctx.fillText(line, pad, y);
        y += lineH;
      }
    }
  }
  return canvas;
}

/** A 1×1 canvas of a solid linear-RGB colour — the texture for a tone panel. */
export function solidColorTexel(color: [number, number, number]): PanelTexel {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("[panel-texture] no 2d context for solid texel");
  const [r, g, b] = color.map((c) => Math.round(clamp01(c) * 255));
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.fillRect(0, 0, 1, 1);
  return canvas;
}

/**
 * Greedy word-wrap of `text` to `maxWidth`, measuring with the injected `measure`
 * (so it is pure + unit-testable without a canvas). A single word longer than the
 * line is emitted on its own line rather than dropped.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const out: string[] = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${line} ${words[i]}`;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
    } else {
      out.push(line);
      line = words[i];
    }
  }
  out.push(line);
  return out;
}

// ── internals ─────────────────────────────────────────────────────────────────

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
