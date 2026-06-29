/// <reference path="./webxr-polyfill.types.ts" />

/**
 * WebXR runtime — the packaging seam that makes the XR modality *real* on every
 * platform where WebXR is supported, and gracefully available where it isn't.
 *
 * Two halves:
 *
 *  1. **Availability.** {@link ensureWebXR} guarantees `navigator.xr` exists:
 *     it leaves a native implementation untouched (WebKitGTK/WPE desktop with an
 *     OpenXR runtime, visionOS/Quest/Wolvic headset browsers, Chromium WebView2 +
 *     a runtime) and lazily installs `webxr-polyfill` only where the API is
 *     missing (Android System WebView, older WebViews) — so a phone gets an
 *     inline / Cardboard-stereo session and every surface can feature-detect.
 *     {@link detectWebXRCapability} reports what the *current* runtime supports.
 *
 *  2. **A real immersive scene.** {@link enterImmersiveScene} requests an
 *     immersive session, binds an `XRWebGLLayer`, and runs a per-eye render loop
 *     that places the authored {@link ImmersivePanel} panels as textured quads at
 *     their world poses using the session's own view/projection matrices. This is
 *     the `XRWebGLLayer` path the deterministic CSS {@link XRSpatialScene} renderer
 *     deliberately leaves to the native compositor; panel position/orientation use
 *     the shared {@link Vec3}/{@link Quat} conventions from `xr-scene-math`,
 *     expanded to a column-major WebGL model matrix locally. Panel *content* is a
 *     real texture — content drawn to an origin-clean 2D canvas via
 *     {@link rasterizePanelToCanvas} (see `panel-texture`), with the panel's tone
 *     colour as the fill/fallback. The `xr-immersive` bridge wraps "build panel
 *     textures → enter" into one call. (DOM-via-`foreignObject` can't feed WebGL —
 *     it taints; see `panel-texture`.)
 *
 * No React here — pure runtime glue (it touches WebGL + a `TexImageSource`) so it
 * unit-tests against the IWER emulator exactly like the rest of the harness; the
 * canvas content rasterization lives in `panel-texture` / `xr-immersive`.
 */

import { type PanelTexel, solidColorTexel } from "./panel-texture.ts";
import type { Quat, Vec3 } from "./xr-scene-math.ts";
// `webxr-polyfill` is untyped; its constructor is declared ambiently in
// ./webxr-polyfill.types.ts, which types the dynamic import below.

/** What the active WebXR runtime can do, after {@link ensureWebXR}. */
export interface WebXRCapability {
  /** `navigator.xr` is present (native or polyfilled). */
  present: boolean;
  /** True when a real native `navigator.xr` was found (no polyfill installed). */
  native: boolean;
  /** A `webxr-polyfill` instance was installed because the API was missing. */
  polyfilled: boolean;
  immersiveVR: boolean;
  immersiveAR: boolean;
  inline: boolean;
}

/** A panel to place in the immersive scene — centre pose + content. */
export interface ImmersivePanel {
  id: string;
  position: Vec3;
  orientation?: Quat;
  width: number;
  height: number;
  /**
   * Linear RGB in 0..1. Used as the quad fill when no {@link ImmersivePanel.texture}
   * is supplied, and as the graceful fallback if a texture upload is rejected (an
   * origin-unclean source). Always required so a panel can never render as a hole.
   */
  color: [number, number, number];
  /**
   * Panel content as an origin-clean texture — typically a
   * {@link rasterizePanelToCanvas} of the panel's content (canvas, not DOM: a
   * `foreignObject` DOM snapshot taints and cannot upload to WebGL). A function is
   * re-invoked by {@link ImmersiveSceneHandle.refreshTextures} so updating content
   * can be re-uploaded on demand. Omit for a solid {@link ImmersivePanel.color} tone.
   */
  texture?: PanelTexel | (() => PanelTexel | null | undefined);
}

export interface ImmersiveSceneOptions {
  mode?: "immersive-vr" | "immersive-ar";
  /** The canvas whose WebGL context backs the `XRWebGLLayer`. */
  canvas: HTMLCanvasElement;
  panels: ImmersivePanel[];
  referenceSpaceType?: XRReferenceSpaceType;
  /** Called once per animation frame after the panels are drawn. */
  onFrame?: (info: {
    frame: XRFrame;
    views: number;
    panelsDrawn: number;
  }) => void;
  onError?: (err: unknown) => void;
}

export interface ImmersiveSceneHandle {
  session: XRSession;
  /** Frames rendered so far (for tests / telemetry). */
  readonly frames: number;
  /**
   * Re-resolve and re-upload panel textures (those given a function source) —
   * call after the panels' DOM content changes so the headset sees the update.
   * Pass panel ids to refresh a subset, or omit for all.
   */
  refreshTextures(ids?: string[]): void;
  end(): Promise<void>;
}

let polyfillInstalled = false;

/**
 * Ensure `navigator.xr` exists, preferring a native implementation. Idempotent.
 * The polyfill is dynamically imported so it never weighs down a bundle that
 * runs only where WebXR is native.
 */
export async function ensureWebXR(): Promise<WebXRCapability> {
  const nav = globalThis.navigator as Navigator | undefined;
  if (nav && "xr" in nav && nav.xr) {
    return capabilityFrom(nav.xr, /* native */ !polyfillInstalled);
  }
  // Missing — install the polyfill once.
  try {
    const { default: WebXRPolyfill } = await import("webxr-polyfill");
    new WebXRPolyfill({ allowCardboardOnDesktop: false });
    polyfillInstalled = true;
  } catch {
    return {
      present: false,
      native: false,
      polyfilled: false,
      immersiveVR: false,
      immersiveAR: false,
      inline: false,
    };
  }
  const xr = (globalThis.navigator as Navigator | undefined)?.xr;
  return xr
    ? capabilityFrom(xr, /* native */ false)
    : {
        present: false,
        native: false,
        polyfilled: false,
        immersiveVR: false,
        immersiveAR: false,
        inline: false,
      };
}

/** Report the current runtime's capability without installing anything. */
export async function detectWebXRCapability(): Promise<WebXRCapability> {
  const xr = (globalThis.navigator as Navigator | undefined)?.xr;
  if (!xr) {
    return {
      present: false,
      native: false,
      polyfilled: polyfillInstalled,
      immersiveVR: false,
      immersiveAR: false,
      inline: false,
    };
  }
  return capabilityFrom(xr, /* native */ !polyfillInstalled);
}

async function capabilityFrom(
  xr: XRSystem,
  native: boolean,
): Promise<WebXRCapability> {
  const supported = async (mode: XRSessionMode) => {
    try {
      return await xr.isSessionSupported(mode);
    } catch {
      return false;
    }
  };
  const [immersiveVR, immersiveAR, inline] = await Promise.all([
    supported("immersive-vr"),
    supported("immersive-ar"),
    supported("inline"),
  ]);
  return {
    present: true,
    native,
    polyfilled: polyfillInstalled,
    immersiveVR,
    immersiveAR,
    inline,
  };
}

// ── Immersive WebGL scene ─────────────────────────────────────────────────────

/**
 * Enter an immersive WebXR session and render the panels as world-placed quads.
 * Throws if `navigator.xr` is absent or the requested mode is unsupported — call
 * {@link ensureWebXR}/{@link detectWebXRCapability} first.
 */
export async function enterImmersiveScene(
  opts: ImmersiveSceneOptions,
): Promise<ImmersiveSceneHandle> {
  const xr = (globalThis.navigator as Navigator | undefined)?.xr;
  if (!xr)
    throw new Error(
      "[webxr] navigator.xr unavailable — call ensureWebXR() first",
    );
  const mode = opts.mode ?? "immersive-vr";

  const gl = (opts.canvas.getContext("webgl2", { xrCompatible: true }) ||
    opts.canvas.getContext("webgl", { xrCompatible: true })) as
    | WebGL2RenderingContext
    | WebGLRenderingContext
    | null;
  if (!gl) throw new Error("[webxr] no WebGL context");
  await (gl as { makeXRCompatible?: () => Promise<void> }).makeXRCompatible?.();

  const session = await xr.requestSession(mode, {
    requiredFeatures: [opts.referenceSpaceType ?? "local"],
  });
  const layer = new XRWebGLLayer(session, gl);
  session.updateRenderState({ baseLayer: layer });
  const refSpace = await session.requestReferenceSpace(
    opts.referenceSpaceType ?? "local",
  );

  const program = buildQuadProgram(gl);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const pLoc = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(pLoc);
  gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 0, 0);
  const mvpLoc = gl.getUniformLocation(program, "mvp");
  const texLoc = gl.getUniformLocation(program, "uTex");
  gl.uniform1i(texLoc, 0); // sampler reads texture unit 0
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // image top → panel top

  // Every panel gets a texture: its rasterized canvas content, or a 1×1 fill of
  // its tone colour. An origin-unclean source degrades to the colour so a panel
  // can never become a hole in the scene.
  const textures = new Map<string, WebGLTexture>();
  const uploadPanel = (panel: ImmersivePanel): void => {
    let tex = textures.get(panel.id);
    if (!tex) {
      const created = gl.createTexture();
      if (!created) throw new Error("[webxr] createTexture failed");
      tex = created;
      textures.set(panel.id, tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const source =
      typeof panel.texture === "function" ? panel.texture() : panel.texture;
    try {
      if (!source) throw new Error("no source");
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source as TexImageSource,
      );
    } catch {
      // No content texture, or a SecurityError from an origin-unclean source:
      // fall back to the panel's solid tone colour.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        solidColorTexel(panel.color) as TexImageSource,
      );
    }
  };
  for (const panel of opts.panels) uploadPanel(panel);

  const state = { frames: 0, ended: false };

  const onXRFrame: XRFrameRequestCallback = (_t, frame) => {
    if (state.ended) return;
    session.requestAnimationFrame(onXRFrame);
    try {
      const pose = frame.getViewerPose(refSpace);
      if (!pose) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      let drawn = 0;
      for (const view of pose.views) {
        const vp = layer.getViewport(view);
        if (!vp) continue;
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        const viewMat = view.transform.inverse.matrix; // world → eye
        for (const panel of opts.panels) {
          const model = panelModelMatrix(panel);
          const mvp = mat4Mul(view.projectionMatrix, mat4Mul(viewMat, model));
          // Cull panels behind the eye (clip w ≤ 0).
          if (mvp[15] <= 0) continue;
          const tex = textures.get(panel.id);
          if (!tex) continue;
          gl.uniformMatrix4fv(mvpLoc, false, mvp);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          drawn++;
        }
      }
      state.frames++;
      opts.onFrame?.({ frame, views: pose.views.length, panelsDrawn: drawn });
    } catch (err) {
      // Surface the render error once and stop the loop rather than spamming it
      // every frame; the already-scheduled callback early-returns on `ended`.
      state.ended = true;
      opts.onError?.(err);
    }
  };
  session.requestAnimationFrame(onXRFrame);

  return {
    session,
    get frames() {
      return state.frames;
    },
    refreshTextures(ids?: string[]) {
      const wanted = ids ? new Set(ids) : null;
      for (const panel of opts.panels) {
        if (wanted && !wanted.has(panel.id)) continue;
        uploadPanel(panel);
      }
    },
    async end() {
      state.ended = true;
      for (const tex of textures.values()) gl.deleteTexture(tex);
      textures.clear();
      try {
        await session.end();
      } catch (err) {
        // session may already be ending — surface it, don't swallow silently.
        opts.onError?.(err);
      }
      // Release the GL objects this scene allocated on the caller-owned canvas
      // (the program + its shaders and the quad buffer); the context itself is
      // the caller's to keep or drop.
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
    },
  };
}

// ── tiny mat4 (column-major, WebGL order) ─────────────────────────────────────

type M4 = Float32Array;

function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>): M4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/** Model matrix: scale (half-extents) → rotate (orientation) → translate (position). */
function panelModelMatrix(panel: ImmersivePanel): M4 {
  const q = panel.orientation ?? { x: 0, y: 0, z: 0, w: 1 };
  const { x, y, z, w } = q;
  // Rotation matrix from quaternion (column-major).
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2;
  const yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  const sx = panel.width / 2,
    sy = panel.height / 2;
  const m = new Float32Array(16);
  m[0] = (1 - (yy + zz)) * sx;
  m[1] = (xy + wz) * sx;
  m[2] = (xz - wy) * sx;
  m[3] = 0;
  m[4] = (xy - wz) * sy;
  m[5] = (1 - (xx + zz)) * sy;
  m[6] = (yz + wx) * sy;
  m[7] = 0;
  m[8] = xz + wy;
  m[9] = yz - wx;
  m[10] = 1 - (xx + yy);
  m[11] = 0;
  m[12] = panel.position.x;
  m[13] = panel.position.y;
  m[14] = panel.position.z;
  m[15] = 1;
  return m;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error("[webxr] createShader failed");
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`[webxr] shader: ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}

function buildQuadProgram(gl: WebGLRenderingContext): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error("[webxr] createProgram failed");
  const vs = compileShader(
    gl,
    gl.VERTEX_SHADER,
    "attribute vec2 p; varying vec2 vUv; uniform mat4 mvp;" +
      "void main(){ vUv = p * 0.5 + 0.5; gl_Position = mvp * vec4(p, 0.0, 1.0); }",
  );
  const fs = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    "precision mediump float; varying vec2 vUv; uniform sampler2D uTex;" +
      "void main(){ gl_FragColor = texture2D(uTex, vUv); }",
  );
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  // The linked program retains its shaders; flag them for deletion so they are
  // freed together with the program (no orphaned shader objects left behind).
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`[webxr] link: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.useProgram(prog);
  return prog;
}
