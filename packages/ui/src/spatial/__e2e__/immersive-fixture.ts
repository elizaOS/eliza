/**
 * Immersive framebuffer-readback fixture — bundled by `run-immersive-e2e.mjs`
 * and loaded in headless Chromium (real WebGL2, no jsdom).
 *
 * Installs the IWER emulated Quest 3 runtime (a real `navigator.xr` +
 * `XRWebGLLayer` implementation, stereo enabled), then drives the PRODUCTION
 * `enterImmersiveScene()` export end-to-end:
 *
 *  - a green 2D-canvas texture panel (the texture-upload path),
 *  - a `rasterizePanelToCanvas` content panel (title + accent rule on a
 *    distinctive background — real drawn content, not a flat fill),
 *  - a panel whose texture source is a genuinely origin-unclean canvas
 *    (a cross-origin image drawn without CORS — the taint the HTML spec
 *    mandates) so `texImage2D` throws a real `SecurityError` and the
 *    production fallback (`solidColorTexel(panel.color)`) engages.
 *
 * The probe reads pixels back from the session framebuffer with
 * `gl.readPixels()` at pixels PREDICTED by independent matrix math (the
 * session's own per-eye view/projection matrices applied to known panel-local
 * points), inside the production render loop's `onFrame` hook — i.e. right
 * after the production draw for that frame, while the layer framebuffer is
 * bound. Under IWER, `XRWebGLLayer.framebuffer` is `null`: the session
 * framebuffer IS the canvas default framebuffer.
 *
 * Nothing under test is mocked: `enterImmersiveScene`, `rasterizePanelToCanvas`
 * and `detectWebXRCapability` are the real exports; `navigator.xr` is IWER's
 * runtime; the GL pipeline is Chromium's.
 */

import { XRDevice, metaQuest3 } from "iwer";
import { rasterizePanelToCanvas } from "../panel-texture.ts";
import {
  detectWebXRCapability,
  enterImmersiveScene,
  type ImmersivePanel,
  type ImmersiveSceneHandle,
  type WebXRCapability,
  type WebXRFrame,
  type WebXRSession,
} from "../webxr-runtime.ts";

// ── Emulator-facing shapes the production types deliberately omit ────────────
// (IWER implements the full WebXR API; the production seam types only what the
// runtime consumes. The fixture needs the layer + view internals to compute
// where a world point lands in the session framebuffer.)

interface EmulatedLayer {
  framebuffer: WebGLFramebuffer | null;
  getViewport(view: EmulatedView): {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

interface EmulatedSession extends WebXRSession {
  renderState: { baseLayer: EmulatedLayer | null };
  addEventListener(type: "end", listener: () => void): void;
}

interface EmulatedView {
  eye: "left" | "right" | "none";
  projectionMatrix: Float32Array;
  transform: { inverse: { matrix: Float32Array } };
}

// ── Result shapes returned to the Node runner (JSON-serializable only) ───────

interface SampleReading {
  panel: string;
  point: string;
  eye: string;
  /** Framebuffer pixel (GL coords, origin bottom-left) the sample was read at. */
  pixel: { x: number; y: number };
  /** Pixel position local to the eye's viewport (for parallax assertions). */
  local: { x: number; y: number };
  viewport: { x: number; y: number; width: number; height: number };
  rgba: number[];
}

interface ProbeResult {
  frames: number;
  views: number;
  panelsDrawn: number;
  framebufferIsNull: boolean;
  canvas: { width: number; height: number };
  glError: number;
  samples: SampleReading[];
}

interface EnterResult {
  capability: WebXRCapability;
  xrWebGLLayerInstalled: boolean;
  taintProbe: { threw: boolean; name: string | null };
  contentTexture: { width: number; height: number };
  framesAfterEnter: number;
}

interface TeardownResult {
  framesAtEnd: number;
  framesAfterWait: number;
  endEventFired: boolean;
  secondSessionGranted: boolean;
}

interface ImmersiveTestApi {
  ready: boolean;
  errors: string[];
  enter(): Promise<EnterResult>;
  probe(): Promise<ProbeResult>;
  refreshAndProbe(): Promise<ProbeResult>;
  teardown(): Promise<TeardownResult>;
}

declare global {
  interface Window {
    __immersive: ImmersiveTestApi;
    /** Cross-origin image URL the runner serves to build a tainted canvas. */
    __taintImageUrl?: string;
  }
}

// ── Scene constants ───────────────────────────────────────────────────────────
// Panels live in the production default `local` reference space: IWER snapshots
// the head pose as the space origin, so "in front of the viewer" is y=0, z<0.

const GREEN_POS = { x: -1.0, y: 0, z: -2 };
const CONTENT_POS = { x: 0, y: 0, z: -2 };
const TAINTED_POS = { x: 1.0, y: 0, z: -2 };
const CONTENT_SIZE = 1.2;
const SIDE_SIZE = 0.8;

// rasterizePanelToCanvas({width:64,height:64,pixelRatio:2}) → a 128×128 canvas
// with pad 36, title font 52 at y 36, and the accent rule at
// fillRect(36, 104, 88, 6). Two deterministic texture-space landmarks:
const CONTENT_TEX = 128;
/** Background texel above the title glyphs, clear of the 28px corner radius. */
const BG_TEXEL = { x: 64, y: 22 };
/** Centre of the accent rule (x 36..124, y 104..110). */
const ACCENT_TEXEL = { x: 80, y: 107 };

/** Texel (top-left origin) → panel-local [-1,1] point. The production upload
 * sets UNPACK_FLIP_Y_WEBGL, so image top row is the quad's top (+y local). */
function texelToLocal(t: { x: number; y: number }): { x: number; y: number } {
  return { x: (t.x / CONTENT_TEX) * 2 - 1, y: 1 - (t.y / CONTENT_TEX) * 2 };
}

/** Panel-local point → world point (panels use identity orientation). */
function localToWorld(
  pos: { x: number; y: number; z: number },
  size: number,
  local: { x: number; y: number },
): [number, number, number] {
  const half = size / 2;
  return [pos.x + local.x * half, pos.y + local.y * half, pos.z];
}

// ── Independent 4×4 math (column-major, GL order) — NOT the production mat4Mul.

function transformPoint(
  m: ArrayLike<number>,
  p: [number, number, number, number],
): [number, number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * p[3],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * p[3],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14] * p[3],
    m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] * p[3],
  ];
}

/** World point → framebuffer pixel for one eye (GL bottom-left origin). */
function projectToPixel(
  view: EmulatedView,
  vp: { x: number; y: number; width: number; height: number },
  world: [number, number, number],
): { x: number; y: number } {
  const eye = transformPoint(view.transform.inverse.matrix, [...world, 1]);
  const clip = transformPoint(view.projectionMatrix, eye);
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  return {
    x: Math.round(vp.x + (ndcX * 0.5 + 0.5) * vp.width),
    y: Math.round(vp.y + (ndcY * 0.5 + 0.5) * vp.height),
  };
}

// ── Texture sources ───────────────────────────────────────────────────────────

function solidCanvas(size: number, fill: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** A genuinely origin-unclean canvas: a cross-origin image (served by the
 * runner on a second 127.0.0.1 port, loaded WITHOUT `crossOrigin`) drawn into
 * a 2D canvas. The HTML spec mandates this taints the canvas, so `texImage2D`
 * throws a real `SecurityError` — the case panel-texture documents.
 * (An SVG `foreignObject` snapshot — the original PoC's taint source — no
 * longer taints in current Chromium, so it can't anchor this test.) */
async function makeTaintedCanvas(): Promise<HTMLCanvasElement> {
  const url = window.__taintImageUrl;
  if (!url) throw new Error("__taintImageUrl not injected by the runner");
  const img = new Image(); // deliberately no crossOrigin — the point is taint
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () =>
      reject(new Error(`cross-origin taint image failed to load: ${url}`));
    img.src = url;
  });
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, 64, 64);
  return c;
}

/** Prove (on a scratch context) that uploading the source really throws — so a
 * green run demonstrably exercised the SecurityError branch, not a silent
 * behavior change in Chromium. */
function probeTaintUpload(source: TexImageSource): {
  threw: boolean;
  name: string | null;
} {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2");
  if (!gl) return { threw: false, name: "no-webgl2" };
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return { threw: false, name: null };
  } catch (err) {
    return {
      threw: true,
      name: err instanceof DOMException ? err.name : String(err),
    };
  }
}

// ── Harness state ─────────────────────────────────────────────────────────────

const errors: string[] = [];
let handle: ImmersiveSceneHandle | null = null;
let sessionCanvas: HTMLCanvasElement | null = null;
let greenCanvas: HTMLCanvasElement | null = null;
let probeRefSpace: object | null = null;
let lastFrameInfo = { views: 0, panelsDrawn: 0 };
let pendingProbe: {
  resolve: (r: ProbeResult) => void;
  reject: (e: unknown) => void;
} | null = null;
let endEventFired = false;

function requireHandle(): ImmersiveSceneHandle {
  if (!handle) throw new Error("enter() has not run");
  return handle;
}

function collectProbe(frame: WebXRFrame): ProbeResult {
  const h = requireHandle();
  const canvas = sessionCanvas;
  if (!canvas || !probeRefSpace) throw new Error("probe before setup complete");
  const session = h.session as EmulatedSession;
  const layer = session.renderState.baseLayer;
  if (!layer) throw new Error("no baseLayer on session renderState");
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("session canvas lost its webgl2 context");
  const pose = frame.getViewerPose(probeRefSpace);
  if (!pose) throw new Error("no viewer pose at probe time");

  const bgLocal = texelToLocal(BG_TEXEL);
  const accentLocal = texelToLocal(ACCENT_TEXEL);
  const targets: Array<{
    panel: string;
    point: string;
    world: [number, number, number];
  }> = [
    { panel: "green", point: "center", world: [GREEN_POS.x, GREEN_POS.y, GREEN_POS.z] },
    { panel: "content", point: "background", world: localToWorld(CONTENT_POS, CONTENT_SIZE, bgLocal) },
    { panel: "content", point: "accent-rule", world: localToWorld(CONTENT_POS, CONTENT_SIZE, accentLocal) },
    { panel: "tainted", point: "center", world: [TAINTED_POS.x, TAINTED_POS.y, TAINTED_POS.z] },
  ];

  const samples: SampleReading[] = [];
  const px = new Uint8Array(4);
  const read = (x: number, y: number): number[] => {
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2], px[3]];
  };

  for (const rawView of pose.views) {
    const view = rawView as EmulatedView;
    const vp = layer.getViewport(view);
    if (!vp || vp.width === 0) continue;
    for (const target of targets) {
      const pixel = projectToPixel(view, vp, target.world);
      samples.push({
        panel: target.panel,
        point: target.point,
        eye: view.eye,
        pixel,
        local: { x: pixel.x - vp.x, y: pixel.y - vp.y },
        viewport: { x: vp.x, y: vp.y, width: vp.width, height: vp.height },
        rgba: read(pixel.x, pixel.y),
      });
    }
    // A point far from every quad — proves the loop's own clear ran.
    samples.push({
      panel: "(none)",
      point: "clear",
      eye: view.eye,
      pixel: { x: vp.x + 8, y: vp.y + vp.height - 8 },
      local: { x: 8, y: vp.height - 8 },
      viewport: { x: vp.x, y: vp.y, width: vp.width, height: vp.height },
      rgba: read(vp.x + 8, vp.y + vp.height - 8),
    });
  }

  return {
    frames: h.frames,
    views: lastFrameInfo.views,
    panelsDrawn: lastFrameInfo.panelsDrawn,
    framebufferIsNull: layer.framebuffer === null,
    canvas: { width: canvas.width, height: canvas.height },
    glError: gl.getError(),
    samples,
  };
}

function requestProbe(): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("probe timed out — render loop not running?")),
      10_000,
    );
    pendingProbe = {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
  });
}

async function waitForFrames(target: number): Promise<void> {
  const h = requireHandle();
  const started = performance.now();
  while (h.frames < target) {
    if (performance.now() - started > 10_000) {
      throw new Error(`render loop stalled at ${h.frames} frames`);
    }
    await new Promise((r) => setTimeout(r, 16));
  }
}

// ── API ───────────────────────────────────────────────────────────────────────

const api: ImmersiveTestApi = {
  ready: true,
  errors,

  async enter(): Promise<EnterResult> {
    // Real IWER runtime: emulated Quest 3, stereo so both eyes get a viewport.
    const device = new XRDevice(metaQuest3, { stereoEnabled: true });
    device.installRuntime();

    // The REAL availability path against the emulated runtime (not a mock).
    const capability = await detectWebXRCapability();

    greenCanvas = solidCanvas(64, "#00ff00");
    const contentCanvas = rasterizePanelToCanvas(
      {
        title: "Immersive",
        lines: [],
        background: "rgb(255, 0, 255)",
        foreground: "rgb(255, 255, 255)",
        accent: "rgb(255, 88, 0)",
      },
      { width: 64, height: 64, pixelRatio: 2 },
    );
    const taintedCanvas = await makeTaintedCanvas();
    const taintProbe = probeTaintUpload(taintedCanvas);

    const panels: ImmersivePanel[] = [
      {
        id: "green",
        position: GREEN_POS,
        width: SIDE_SIZE,
        height: SIDE_SIZE,
        // Red fallback: if the texture path silently failed we'd read red.
        color: [1, 0, 0],
        texture: greenCanvas,
      },
      {
        id: "content",
        position: CONTENT_POS,
        width: CONTENT_SIZE,
        height: CONTENT_SIZE,
        color: [1, 0, 0],
        texture: contentCanvas,
      },
      {
        id: "tainted",
        position: TAINTED_POS,
        width: SIDE_SIZE,
        height: SIDE_SIZE,
        // The tone the SecurityError fallback must render: rgb(255, 153, 0).
        color: [1, 0.6, 0],
        texture: taintedCanvas,
      },
    ];

    sessionCanvas = document.createElement("canvas");
    sessionCanvas.width = 640;
    sessionCanvas.height = 480; // IWER resizes it to window dims on layer set.
    document.body.appendChild(sessionCanvas);

    handle = await enterImmersiveScene({
      canvas: sessionCanvas,
      panels,
      onFrame: (info) => {
        lastFrameInfo = { views: info.views, panelsDrawn: info.panelsDrawn };
        if (pendingProbe && probeRefSpace) {
          const p = pendingProbe;
          pendingProbe = null;
          try {
            p.resolve(collectProbe(info.frame));
          } catch (err) {
            p.reject(err);
          }
        }
      },
      onError: (err) => errors.push(String(err)),
    });
    (handle.session as EmulatedSession).addEventListener("end", () => {
      endEventFired = true;
    });
    probeRefSpace = await handle.session.requestReferenceSpace("local");
    await waitForFrames(3);

    return {
      capability,
      xrWebGLLayerInstalled: "XRWebGLLayer" in globalThis,
      taintProbe,
      contentTexture: { width: contentCanvas.width, height: contentCanvas.height },
      framesAfterEnter: handle.frames,
    };
  },

  probe(): Promise<ProbeResult> {
    requireHandle();
    return requestProbe();
  },

  async refreshAndProbe(): Promise<ProbeResult> {
    const h = requireHandle();
    if (!greenCanvas) throw new Error("green canvas missing");
    const ctx = greenCanvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = "#ffff00";
    ctx.fillRect(0, 0, greenCanvas.width, greenCanvas.height);
    h.refreshTextures(["green"]);
    return requestProbe();
  },

  async teardown(): Promise<TeardownResult> {
    const h = requireHandle();
    const framesAtEnd = h.frames;
    await h.end();
    // Several RAF periods: a dangling loop would keep incrementing frames.
    await new Promise((r) => setTimeout(r, 300));
    const framesAfterWait = h.frames;
    // IWER rejects a second session while one is active — a grant here proves
    // the production end() actually released the session.
    let secondSessionGranted = false;
    const xr = (navigator as Navigator & {
      xr?: {
        requestSession(mode: string): Promise<{ end(): Promise<void> }>;
      };
    }).xr;
    if (xr) {
      const second = await xr.requestSession("immersive-vr");
      secondSessionGranted = true;
      await second.end();
    }
    return { framesAtEnd, framesAfterWait, endEventFired, secondSessionGranted };
  },
};

window.__immersive = api;
