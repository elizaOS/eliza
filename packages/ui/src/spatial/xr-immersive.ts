/**
 * xr-immersive — author panels once, go immersive in one call.
 *
 * Bridges lightweight panel descriptions (text content + 3D pose) to the WebGL
 * {@link enterImmersiveScene} renderer: each panel's content is drawn to an
 * origin-clean canvas (`panel-texture`) and uploaded as a textured quad at its
 * world pose. `navigator.xr` is ensured (native preferred, polyfill fallback)
 * before the session is requested.
 *
 * Content is a `{ title, lines }` text model (or a caller-supplied `texture`),
 * not live DOM — a `foreignObject` DOM snapshot can't upload to WebGL (it taints;
 * see `panel-texture`). Rich interactive DOM stays on the CSS `XRSpatialScene`
 * (flat-DOM) path; this is the immersive-compositor path. No React/DOM mount here,
 * so it ships on its own subpath (`@elizaos/ui/spatial/immersive`).
 */

import {
  type PanelContent,
  type PanelTexel,
  rasterizePanelToCanvas,
} from "./panel-texture.ts";
import {
  ensureWebXR,
  enterImmersiveScene,
  type ImmersivePanel,
  type ImmersiveSceneHandle,
  type ImmersiveSceneOptions,
} from "./webxr-runtime.ts";
import {
  arrangeOnArc,
  billboardOrientation,
  type Vec3,
} from "./xr-scene-math.ts";

/** Eye pose the panels billboard toward and the arc fans out from. */
const DEFAULT_HEAD: Vec3 = { x: 0, y: 1.6, z: 0 };
/** Linear-RGB tone behind a panel — the fallback fill if rasterization is unavailable. */
const PANEL_FALLBACK_COLOR: [number, number, number] = [0.07, 0.07, 0.1];

/** An immersive panel: a 3D placement + its text content (or a ready texture). */
export interface ImmersivePanelSpec extends PanelContent {
  id: string;
  /** World position of the panel centre. Omit to auto-arrange on a frontal arc. */
  position?: Vec3;
  /** Panel width in metres (default 1.2). */
  width?: number;
  /** Panel height in metres (default 0.9). */
  height?: number;
  /** A ready-made origin-clean texture, overriding the drawn content. */
  texture?: PanelTexel;
}

export interface ImmersiveFromSpecsOptions {
  /** Canvas whose WebGL context backs the `XRWebGLLayer`. */
  canvas: HTMLCanvasElement;
  mode?: "immersive-vr" | "immersive-ar";
  /** DOM px per world metre — the rasterized panel design resolution (default 900). */
  pixelsPerMeter?: number;
  /** Arc distance (m) for auto-arranged panels without an explicit position (default 2.4). */
  arrangeDistance?: number;
  /** Supersample factor for crisp panel textures in a headset (default 2). */
  pixelRatio?: number;
  onFrame?: ImmersiveSceneOptions["onFrame"];
}

/**
 * Turn panel specs into world-placed {@link ImmersivePanel}s with real
 * rasterized-content textures (each `{ title, lines }` drawn to a canvas, or the
 * caller's `texture`). Pure builder — no session, no DOM mount.
 */
export function buildImmersivePanels(
  specs: ImmersivePanelSpec[],
  opts: Pick<
    ImmersiveFromSpecsOptions,
    "pixelsPerMeter" | "arrangeDistance" | "pixelRatio"
  > = {},
): ImmersivePanel[] {
  const ppm = opts.pixelsPerMeter ?? 900;
  const ratio = opts.pixelRatio ?? 2;
  const arc = arrangeOnArc(specs.length, {
    distance: opts.arrangeDistance ?? 2.4,
    center: DEFAULT_HEAD,
  });
  return specs.map((spec, i) => {
    const width = spec.width ?? 1.2;
    const height = spec.height ?? 0.9;
    const position = spec.position ?? arc[i];
    let texture = spec.texture;
    if (!texture && (spec.title || spec.lines?.length)) {
      texture = rasterizePanelToCanvas(spec, {
        width: width * ppm,
        height: height * ppm,
        pixelRatio: ratio,
      });
    }
    return {
      id: spec.id,
      position,
      orientation: billboardOrientation(position, DEFAULT_HEAD),
      width,
      height,
      color: PANEL_FALLBACK_COLOR,
      texture,
    };
  });
}

/**
 * Author panels → ensure WebXR → draw content textures → enter the immersive scene.
 */
export async function enterImmersiveFromSpecs(
  specs: ImmersivePanelSpec[],
  opts: ImmersiveFromSpecsOptions,
): Promise<ImmersiveSceneHandle> {
  await ensureWebXR();
  const panels = buildImmersivePanels(specs, opts);
  return enterImmersiveScene({
    canvas: opts.canvas,
    mode: opts.mode,
    panels,
    onFrame: opts.onFrame,
  });
}
