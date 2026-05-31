// Vendored from the milady face-rig prototype (`rig-runtime.mjs`, THE KEYSTONE,
// owner: FIDELITY agent). Framework-agnostic puppet runtime for the negative
// space anime portrait: a baked rest-pose SVG plus a param model that drives
// riggable overlays (jaw cavity, eyelids, brows) and transform groups.
//
// Ported verbatim to TypeScript; logic is identical to the source. The FIDELITY
// agent is concurrently improving the prototype, so this file (and rigArt.ts)
// will be re-synced at integration. Keep it dependency-free.
//
// Do not rename `RigParams` fields or the exported names without updating the
// prototype CONTRACT.md.
import { ART_PATHS, type BrowGeo, GEO } from "./rigArt";

const VB = "0 0 423 423";

const r2 = (n: number): number => Math.round(n * 100) / 100;

// Mouth interior: a lens that opens DOWNWARD from the resting lip line. Anchored at its top
// (transform-origin 50% 0%) so scaleY grows it into the chin while the upper-lip edge stays put.
// Authored at full open (jaw=1, wide=1); applyParams scales it (scaleY=open, scaleX=width) so
// the height/width ratio yields distinct viseme shapes (tall=ah, flat-wide=ee, round=oh/oo).
const M = GEO.mouth;
// The cavity TOP overlaps the inked rest-lip (which spans ~y300..306) so an open mouth merges
// with the upper lip — no white sliver. Bottom is a smooth rounded bowl (the lower lip). The
// element is anchored transform-origin 50% 0% at `mTop`, so scaleY grows the bowl downward and
// scaleX widens it; rest is scaleY(0) -> invisible (lip line in base art is the closed mouth).
const mTop = M.lipY - 0.6; // tuck up under the inked lip so they connect (no floating sliver)
const mHalf = M.w / 2;
const mL = M.cx - mHalf;
const mR = M.cx + mHalf;
const mCorner = M.cx + mHalf - 1.4; // top corners pulled in slightly to kill silhouette nubs
const mCornerL = M.cx - mHalf + 1.4;
const mBot = mTop + M.openMax; // fully-open lower-lip apex
const mMidY = mTop + M.openMax * 0.6;
const mouthCavity =
  `M${r2(mCornerL)} ${r2(mTop)} ` +
  `Q${r2(mL)} ${r2(mTop)} ${r2(mL)} ${r2(mTop + 1.2)} ` + // rounded top-left mouth corner
  `Q${r2(mL)} ${r2(mMidY)} ${r2(M.cx - mHalf * 0.5)} ${r2(mBot)} ` + // left wall -> bottom
  `Q${r2(M.cx)} ${r2(mBot + 0.6)} ${r2(M.cx + mHalf * 0.5)} ${r2(mBot)} ` + // rounded lower lip
  `Q${r2(mR)} ${r2(mMidY)} ${r2(mR)} ${r2(mTop + 1.2)} ` + // right wall up
  `Q${r2(mR)} ${r2(mTop)} ${r2(mCorner)} ${r2(mTop)} Z`; // rounded top-right corner

// Brow wedge = an upper-lid accent that rides the lash line. Authored as a sliver that is THICK
// at the inner (face-center, left) end and tapers to a point at the outer end — the anime
// "eyelid wedge". The base `tilt` (deg) aligns it to the lash; applyParams hinges it about the
// inner end (transform-origin set on the element) so browAngle drops/lifts the inner corner and
// browRaise floats the whole sliver. The taper means rotation reads as an eyelid, not a bar.
function browWedge(g: BrowGeo): string {
  const x0 = g.cx - g.w / 2;
  const x1 = g.cx + g.w / 2; // inner (thick) left .. outer (point) right
  const yc = g.cy;
  const h = g.h;
  // build flat, then rotate by tilt about the inner end (x0,yc).
  const pts: ReadonlyArray<readonly [number, number]> = [
    [x0, yc - h * 0.5], // inner top
    [x0 + g.w * 0.5, yc - h * 0.62], // mid top (slight arch)
    [x1, yc], // outer point
    [x0 + g.w * 0.45, yc + h * 0.5], // mid bottom
    [x0, yc + h * 0.5], // inner bottom
  ];
  const t = ((g.tilt || 0) * Math.PI) / 180;
  const ct = Math.cos(t);
  const st = Math.sin(t);
  const rot = pts.map(([x, y]): readonly [number, number] => {
    const dx = x - x0;
    const dy = y - yc;
    return [x0 + dx * ct - dy * st, yc + dx * st + dy * ct];
  });
  const P = rot.map(([x, y]) => `${r2(x)} ${r2(y)}`);
  return `M${P[0]} Q${P[1]} ${P[2]} Q${P[3]} ${P[4]} Z`;
}
const browNearPath = browWedge(GEO.browNear);
const browFarPath = browWedge(GEO.browFar);

// Note: lookX/lookY are accepted but no-op. The eyes are solid-black iris (notan); a dark pupil
// overlay can't be SEEN moving on a dark iris, and any lighter overlay would break the silhouette
// and collide with the inked catchlight — so "look" is intentionally not visualized here.

// Eye-opening clips. The authored lid ellipses are generous and, at full close,
// spill left onto the nose-bridge and up over the dark glasses frame — a blink
// would paint white over the black specs. Each lid is masked to a tighter window
// that hugs the eye opening INSIDE the lens, so the blink squishes the eye shut
// without ever touching the frame. Tuned against rendered closed-eye frames.
interface EyeClip {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}
const EYE_CLIP_NEAR: EyeClip = { cx: 263, cy: 153, rx: 28, ry: 23 };
const EYE_CLIP_FAR: EyeClip = { cx: 333, cy: 184, rx: 18, ry: 16 };
const clipEllipse = (c: EyeClip): string =>
  `<ellipse cx="${c.cx}" cy="${c.cy}" rx="${c.rx}" ry="${c.ry}"/>`;

/**
 * One frame of the rig's parameter model. Every field is a plain scalar so the
 * model is trivially serializable and the per-frame cost stays cheap. Ranges are
 * documented per field; values outside them are clamped where it matters.
 */
export interface RigParams {
  /** 0..1 mouth open (jaw drop). */
  jaw: number;
  /** 0.6..1.6 mouth width. */
  jawWide: number;
  /** One of {@link VISEMES} keys; overrides jaw/jawWide when set. */
  viseme: RigViseme | null;
  /** 0..1 (1 = closed) left/near eye lid close. */
  blinkL: number;
  /** 0..1 (1 = closed) right/far eye lid close. */
  blinkR: number;
  /** 0..1 expressive lower-lid raise (folded into the lids). */
  eyeNarrow: number;
  /** -1..1 brow down..up. */
  browRaise: number;
  /** -1..1 sad/inner-up .. angry/inner-down. */
  browAngle: number;
  /** -1..1 eye dart x (no-op until pupils are added). */
  lookX: number;
  /** -1..1 eye dart y (no-op until pupils are added). */
  lookY: number;
  /** -1..1 -> head translate x. */
  headTurn: number;
  /** -1..1 -> head translate y. */
  headNod: number;
  /** -1..1 -> head rotate. */
  headTilt: number;
  /** 0..1 idle chest/scale. */
  breathe: number;
}

/** Per-frame envelope toggles the director layers on top of the target pose. */
export interface DirectorFlags {
  /** Drive the talking jaw envelope. */
  talk?: boolean;
  /** Allow periodic blinks (default on). */
  blink?: boolean;
  /** Apply idle head sway + breathing (default on). */
  idle?: boolean;
}

/** Stateful procedural director: blends toward a target pose and layers envelopes. */
export interface Director {
  /** Snap the blend target to a named emotion preset. */
  setEmotion(name: RigEmotion): void;
  /** Merge a partial pose into the current blend target. */
  setTarget(partial: Partial<RigParams>): void;
  /** Advance by `dt` seconds and return the next full param frame. */
  tick(dt: number, flags?: DirectorFlags): RigParams;
}

/**
 * Viseme name -> [jawOpen, jawWide]. jawOpen scales the cavity height (0..1 of
 * openMax), jawWide scales its width. Distinct mouth SHAPES emerge from the
 * height/width ratio of the same lens: tall+narrow = oh/oo, wide+flat = ee,
 * balanced+tall = ah, flat = mm/rest.
 */
export const VISEMES = {
  rest: [0, 1],
  closed: [0, 1],
  mm: [0, 1],
  fv: [0.16, 1.05],
  ah: [0.95, 1.04],
  aa: [0.8, 1.16],
  ee: [0.34, 1.5],
  ih: [0.32, 1.28],
  oh: [0.74, 0.74],
  oo: [0.5, 0.58],
} as const satisfies Record<string, readonly [number, number]>;

/** A valid viseme key. */
export type RigViseme = keyof typeof VISEMES;

export const RIG_SVG = `<svg id="face" viewBox="${VB}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="eyeClipNear">${clipEllipse(EYE_CLIP_NEAR)}</clipPath>
    <clipPath id="eyeClipFar">${clipEllipse(EYE_CLIP_FAR)}</clipPath>
  </defs>
  <g id="root" style="transform-box:view-box;transform-origin:${GEO.rootPivot.x}px ${GEO.rootPivot.y}px">
    <g id="head" style="transform-box:view-box;transform-origin:${GEO.headPivot.x}px ${GEO.headPivot.y}px">
      <g id="base" fill="#fff">${ART_PATHS}</g>
      <g id="brows" fill="#000">
        <path id="browNear" d="${browNearPath}" opacity="0" style="transform-box:fill-box;transform-origin:6% 50%"/>
        <path id="browFar" d="${browFarPath}" opacity="0" style="transform-box:fill-box;transform-origin:6% 50%"/>
      </g>
      <g id="eyes" fill="#fff">
        <g clip-path="url(#eyeClipNear)"><ellipse id="lidNear" cx="${GEO.eyeNear.cx}" cy="${GEO.eyeNear.cy}" rx="${GEO.eyeNear.rx}" ry="${GEO.eyeNear.ry}" style="transform-box:fill-box;transform-origin:50% 0%;transform:scaleY(0)"/></g>
        <g clip-path="url(#eyeClipFar)"><ellipse id="lidFar" cx="${GEO.eyeFar.cx}" cy="${GEO.eyeFar.cy}" rx="${GEO.eyeFar.rx}" ry="${GEO.eyeFar.ry}" style="transform-box:fill-box;transform-origin:50% 0%;transform:scaleY(0)"/></g>
      </g>
      <g id="mouth" fill="#000">
        <path id="jaw" d="${mouthCavity}" style="transform-box:fill-box;transform-origin:50% 0%;transform:scaleY(0)"/>
      </g>
    </g>
  </g>
</svg>`;

export const defaultParams: RigParams = {
  jaw: 0,
  jawWide: 1,
  viseme: null,
  blinkL: 0,
  blinkR: 0,
  eyeNarrow: 0,
  browRaise: 0,
  browAngle: 0,
  lookX: 0,
  lookY: 0,
  headTurn: 0,
  headNod: 0,
  headTilt: 0,
  breathe: 0,
};

/** Emotion presets = sparse {@link RigParams} partials. Tuned to stay on-model (subtle) yet distinct. */
export const EMOTIONS = {
  neutral: {},
  // happy = ^_^ squint carries it; the mouth only subtly widens (notan can't curl a lip up).
  happy: {
    jaw: 0.1,
    jawWide: 1.22,
    eyeNarrow: 0.62,
    browRaise: 0.3,
    browAngle: -0.1,
    headNod: -0.08,
    headTurn: 0.08,
    headTilt: 0.12,
  },
  content: {
    jaw: 0,
    jawWide: 1.1,
    eyeNarrow: 0.48,
    browRaise: 0.16,
    headTilt: 0.08,
    headNod: -0.04,
  },
  sad: {
    jaw: 0.06,
    jawWide: 0.9,
    eyeNarrow: 0.22,
    browAngle: -0.78,
    browRaise: -0.12,
    headNod: 0.44,
    headTurn: -0.18,
    headTilt: -0.3,
  },
  surprised: {
    jaw: 0.66,
    jawWide: 0.8,
    browRaise: 1,
    browAngle: 0.06,
    eyeNarrow: 0,
    headNod: -0.3,
  },
  angry: {
    jaw: 0.12,
    jawWide: 1.04,
    eyeNarrow: 0.42,
    browAngle: 0.92,
    browRaise: -0.32,
    headNod: 0.12,
    headTilt: 0.07,
  },
  thinking: {
    jaw: 0,
    jawWide: 0.96,
    eyeNarrow: 0.32,
    browRaise: 0.26,
    browAngle: 0.16,
    headTurn: 0.52,
    headTilt: 0.36,
    lookX: 0.45,
    lookY: -0.2,
  },
  confused: {
    jaw: 0.1,
    jawWide: 0.92,
    eyeNarrow: 0.2,
    browRaise: 0.42,
    browAngle: 0.5,
    headTilt: -0.42,
    headTurn: 0.18,
    lookX: 0.2,
  },
  sigh: {
    jaw: 0.4,
    jawWide: 1.04,
    eyeNarrow: 0.62,
    browAngle: -0.34,
    browRaise: -0.1,
    headNod: 0.5,
    headTilt: -0.18,
  },
  wink: {
    jaw: 0.1,
    jawWide: 1.2,
    eyeNarrow: 0.2,
    browRaise: 0.15,
    blinkL: 1,
    headTilt: 0.14,
    headTurn: 0.08,
  },
} as const satisfies Record<string, Partial<RigParams>>;

/** A valid emotion preset key. */
export type RigEmotion = keyof typeof EMOTIONS;

const clamp = (v: number, a = 0, b = 1): number => (v < a ? a : v > b ? b : v);

/**
 * Write a full {@link RigParams} onto a mounted rig (the `<svg id="face">`
 * element or any ancestor). Pure DOM writes — no reads, no layout — so it is
 * cheap to call every animation frame.
 */
export function applyParams(root: Element, p: RigParams): void {
  const get = (id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`#${id}`);

  // --- mouth: scale the lens cavity. viseme overrides open/wide. ---
  let jaw = p.jaw;
  let wide = p.jawWide;
  if (p.viseme && VISEMES[p.viseme]) {
    const [vj, vw] = VISEMES[p.viseme];
    jaw = Math.max(jaw, vj);
    wide = vw;
  }
  const jawEl = get("jaw");
  if (jawEl)
    jawEl.style.transform = `scaleX(${r2(clamp(wide, 0.4, 1.8))}) scaleY(${r2(clamp(jaw))})`;

  // --- eyelids: skin ellipse scales down from the lash to cover the dark iris. ---
  const lid = (el: HTMLElement | null, v: number): void => {
    if (el)
      el.style.transform = `scaleY(${r2(clamp(Math.max(v, p.eyeNarrow * 0.5)))})`;
  };
  lid(get("lidNear"), p.blinkL);
  lid(get("lidFar"), p.blinkR);

  // --- brows: opacity from |raise|+|angle|; translateY for raise; rotate about the inner
  // (thick) end for angle. Both wedges have their inner end on the left, so a single sign
  // works for both: +angle (angry) tilts inner-down, -angle (sad) tilts inner-up.
  const brow = (el: HTMLElement | null): void => {
    if (!el) return;
    el.style.opacity = String(
      r2(clamp(Math.abs(p.browRaise) * 1.1 + Math.abs(p.browAngle) * 1.25)),
    );
    el.style.transform = `translateY(${r2(-p.browRaise * 5.5)}px) rotate(${r2(p.browAngle * 15)}deg)`;
  };
  brow(get("browNear"));
  brow(get("browFar"));

  // --- head + breathe ---
  const head = get("head");
  if (head) {
    head.style.transform = `translate(${r2(p.headTurn * 7)}px,${r2(p.headNod * 7)}px) rotate(${r2(p.headTilt * 6)}deg)`;
  }
  const rt = get("root");
  if (rt) rt.style.transform = `scale(${r2(1 + p.breathe * 0.012)})`;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const EASED = [
  "jaw",
  "jawWide",
  "eyeNarrow",
  "browRaise",
  "browAngle",
  "headTurn",
  "headNod",
  "headTilt",
  "lookX",
  "lookY",
] as const satisfies ReadonlyArray<keyof RigParams>;

/**
 * Create a {@link Director}: a stateful procedural animator that blends toward a
 * target emotion and layers idle sway, blink, and talk envelopes. `tick(dt)`
 * advances the simulation and returns the next full param frame.
 */
export function createDirector(): Director {
  let target: RigParams = { ...defaultParams };
  const cur: RigParams = { ...defaultParams };
  let talkPhase = 0;
  let nextBlink = 1.2;
  let blinkT = -1;
  let time = 0;
  return {
    setEmotion(name: RigEmotion): void {
      target = { ...defaultParams, ...(EMOTIONS[name] ?? {}) };
    },
    setTarget(partial: Partial<RigParams>): void {
      target = { ...target, ...partial };
    },
    tick(dt: number, flags: DirectorFlags = {}): RigParams {
      time += dt;
      const k = 1 - 0.0015 ** dt;
      for (const key of EASED) cur[key] = lerp(cur[key], target[key] ?? 0, k);
      const out: RigParams = {
        ...cur,
        viseme: null,
        blinkL: target.blinkL || 0,
        blinkR: target.blinkR || 0,
        breathe: 0,
      };
      if (flags.talk) {
        talkPhase += dt * 9;
        const env =
          (Math.sin(talkPhase) * 0.5 + 0.5) *
          (0.55 + 0.45 * Math.sin(talkPhase * 0.37 + 1));
        const gate = Math.max(0, Math.sin(talkPhase * 0.21));
        out.jaw = Math.max(cur.jaw, env * gate * 0.9);
        out.jawWide = cur.jawWide * (1 + 0.12 * Math.sin(talkPhase * 1.7));
      }
      let blink = 0;
      if (flags.blink !== false) {
        if (blinkT >= 0) {
          blinkT += dt;
          const d = blinkT / 0.12;
          blink = d < 1 ? d : Math.max(0, 2 - d);
          if (blinkT > 0.24) {
            blinkT = -1;
            nextBlink = time + 1.4 + Math.random() * 3.6;
          }
        } else if (time >= nextBlink) {
          blinkT = 0;
        }
      }
      out.blinkL = Math.max(out.blinkL, cur.eyeNarrow * 0.5, blink);
      out.blinkR = Math.max(out.blinkR, cur.eyeNarrow * 0.5, blink);
      if (flags.idle !== false) {
        out.headTurn = cur.headTurn + Math.sin(time * 0.5) * 0.18;
        out.headNod = cur.headNod + Math.sin(time * 1.1) * 0.16;
        out.headTilt = cur.headTilt + Math.sin(time * 0.37) * 0.1;
        out.breathe = Math.sin(time * 1.1) * 0.5 + 0.5;
      }
      return out;
    },
  };
}
