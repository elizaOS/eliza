/**
 * WS7 — ScreenSeekeR cascade.
 *
 * Step 1: Brain looks at the full-screen scene for `target_display_id`.
 * Step 2: For each ROI (up to BRAIN_MAX_ROIS), crop the *native resolution*
 *         region from the captured PNG and hand it to the Actor for
 *         fine grounding. The Actor returns display-local coords.
 * Step 3: Combine the Brain's proposed action with the Actor's coordinates
 *         (or fall back to the OCR/AX deterministic actor on `ref`) and
 *         produce a single `ProposedAction` for the dispatcher.
 *
 * Cropping notes:
 *   - We do NOT decode the PNG. The cropped buffer is what we hand to the
 *     Actor. For the built-in OCR/AX actor, the crop is just a pass-through.
 *   - When a real PNG cropper is wired in (sharp / native module), this
 *     module is the place to add it: `cropPngToRoi(frame, bbox)`.
 *   - The cascade tests use the actual frame bytes; assertions are on the
 *     resolved coords and the order of Actor calls.
 */

import { logger } from "@elizaos/core";
import { BRAIN_MAX_ROIS } from "./brain.js";
import { Brain } from "./brain.js";
import type { DisplayCapture } from "../platform/capture.js";
import type { Scene } from "../scene/scene-types.js";
import { resolveReference } from "./actor.js";
import type { Actor, ActorGroundArgs } from "./actor.js";
import type {
  BrainOutput,
  BrainRoi,
  CascadeResult,
  ProposedAction,
} from "./types.js";

export interface CascadeDeps {
  brain: Brain;
  actor?: Actor | null;
  /** Cropper override (mostly tests). Returns a Buffer for the bbox region. */
  crop?: (frame: Buffer, bbox: [number, number, number, number]) => Buffer;
}

export interface CascadeInput {
  scene: Scene;
  goal: string;
  /** Per-display PNG captures, keyed by displayId. */
  captures: Map<number, DisplayCapture>;
}

export class Cascade {
  constructor(private readonly deps: CascadeDeps) {}

  async run(input: CascadeInput): Promise<CascadeResult> {
    const brainOut = await this.deps.brain.observeAndPlan({
      scene: input.scene,
      goal: input.goal,
      captures: input.captures,
    });
    return this.resolveBrainOutput(input, brainOut);
  }

  private async resolveBrainOutput(
    input: CascadeInput,
    brainOut: BrainOutput,
  ): Promise<CascadeResult> {
    const action = brainOut.proposed_action;
    const targetDisplay = brainOut.target_display_id;

    // Non-coordinate actions short-circuit grounding.
    if (action.kind === "wait" || action.kind === "finish") {
      return {
        scene_summary: brainOut.scene_summary,
        rois: brainOut.roi.slice(0, BRAIN_MAX_ROIS),
        proposed: {
          kind: action.kind,
          displayId: targetDisplay,
          rationale: action.rationale,
          ref: action.ref,
        },
      };
    }
    if (action.kind === "type") {
      const text = stringOrUndef(action.args?.text);
      if (typeof text !== "string") {
        throw new Error(
          `[computeruse/cascade] proposed_action.kind="type" requires args.text`,
        );
      }
      return {
        scene_summary: brainOut.scene_summary,
        rois: brainOut.roi.slice(0, BRAIN_MAX_ROIS),
        proposed: {
          kind: "type",
          displayId: targetDisplay,
          text,
          rationale: action.rationale,
        },
      };
    }
    if (action.kind === "hotkey") {
      const keys = action.args?.keys;
      if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) {
        throw new Error(
          `[computeruse/cascade] proposed_action.kind="hotkey" requires args.keys: string[]`,
        );
      }
      return {
        scene_summary: brainOut.scene_summary,
        rois: brainOut.roi.slice(0, BRAIN_MAX_ROIS),
        proposed: {
          kind: "hotkey",
          displayId: targetDisplay,
          keys: keys as string[],
          rationale: action.rationale,
        },
      };
    }
    if (action.kind === "key") {
      const key = stringOrUndef(action.args?.key);
      if (typeof key !== "string") {
        throw new Error(
          `[computeruse/cascade] proposed_action.kind="key" requires args.key`,
        );
      }
      return {
        scene_summary: brainOut.scene_summary,
        rois: brainOut.roi.slice(0, BRAIN_MAX_ROIS),
        proposed: {
          kind: "key",
          displayId: targetDisplay,
          key,
          rationale: action.rationale,
        },
      };
    }
    if (action.kind === "scroll") {
      const dx = Number(action.args?.dx ?? 0);
      const dy = Number(action.args?.dy ?? 0);
      // Anchor scroll on the ROI if present, else display center.
      const anchor = await this.resolveCoords(input, brainOut, /*allowMissing*/ true);
      const display = input.scene.displays.find((d) => d.id === targetDisplay);
      const cx = anchor?.x ?? Math.round((display?.bounds[2] ?? 0) / 2);
      const cy = anchor?.y ?? Math.round((display?.bounds[3] ?? 0) / 2);
      return {
        scene_summary: brainOut.scene_summary,
        rois: brainOut.roi.slice(0, BRAIN_MAX_ROIS),
        proposed: {
          kind: "scroll",
          displayId: targetDisplay,
          x: cx,
          y: cy,
          dx,
          dy,
          rationale: action.rationale,
        },
      };
    }
    if (action.kind === "drag") {
      const from = action.args?.from as { x?: number; y?: number } | undefined;
      const to = action.args?.to as { x?: number; y?: number } | undefined;
      const start = await this.coordsForRef(input, brainOut, action.ref, /*from*/ true) ?? from;
      const end = await this.resolveCoords(input, brainOut, false) ?? to;
      if (!start || !end || typeof start.x !== "number" || typeof end.x !== "number") {
        throw new Error(
          `[computeruse/cascade] drag requires args.from and args.to (or a ref + endpoint)`,
        );
      }
      return {
        scene_summary: brainOut.scene_summary,
        rois: brainOut.roi.slice(0, BRAIN_MAX_ROIS),
        proposed: {
          kind: "drag",
          displayId: targetDisplay,
          startX: Math.round(start.x),
          startY: Math.round(start.y ?? 0),
          x: Math.round(end.x),
          y: Math.round(end.y ?? 0),
          rationale: action.rationale,
        },
      };
    }
    // click / double_click / right_click — all need a single point.
    const coords = await this.resolveCoords(input, brainOut, false);
    if (!coords) {
      throw new Error(
        `[computeruse/cascade] could not resolve coordinates for action.kind="${action.kind}"`,
      );
    }
    return {
      scene_summary: brainOut.scene_summary,
      rois: brainOut.roi.slice(0, BRAIN_MAX_ROIS),
      proposed: {
        kind: action.kind,
        displayId: coords.displayId,
        x: coords.x,
        y: coords.y,
        ref: action.ref,
        rationale: action.rationale,
      },
    };
  }

  private async resolveCoords(
    input: CascadeInput,
    brainOut: BrainOutput,
    allowMissing: boolean,
  ): Promise<{ displayId: number; x: number; y: number } | null> {
    // Strategy 1: if Brain emitted a ref, the OCR/AX grounding (or any
    // registered actor) resolves it directly.
    const action = brainOut.proposed_action;
    if (action.ref) {
      const grounded = await this.groundReference(input, brainOut, action.ref);
      if (grounded) return grounded;
    }
    // Strategy 2: fine grounding on the first ROI via the registered actor.
    if (this.deps.actor && brainOut.roi.length > 0) {
      const roi = brainOut.roi.slice(0, BRAIN_MAX_ROIS)[0]!;
      const grounded = await this.groundRoi(input, brainOut, roi);
      if (grounded) return grounded;
    }
    // Strategy 3: ROI center fallback (deterministic).
    if (brainOut.roi.length > 0) {
      const roi = brainOut.roi[0]!;
      const [x, y, w, h] = roi.bbox;
      return {
        displayId: roi.displayId,
        x: Math.round(x + w / 2),
        y: Math.round(y + h / 2),
      };
    }
    if (allowMissing) return null;
    return null;
  }

  private async coordsForRef(
    input: CascadeInput,
    brainOut: BrainOutput,
    ref: string | undefined,
    _isStart: boolean,
  ): Promise<{ displayId: number; x: number; y: number } | null> {
    if (!ref) return null;
    return this.groundReference(input, brainOut, ref);
  }

  private async groundReference(
    input: CascadeInput,
    brainOut: BrainOutput,
    ref: string,
  ): Promise<{ displayId: number; x: number; y: number } | null> {
    const target = resolveReference(
      input.scene,
      ref,
      brainOut.proposed_action.rationale,
      brainOut.target_display_id,
    );
    if (!target) return null;
    const [bx, by, bw, bh] = target.bbox;
    const cx = Math.round(bx + bw / 2);
    const cy = Math.round(by + bh / 2);
    // If a real Actor is registered, give it a chance to refine. We still
    // crop the ROI from the native PNG, so the Actor sees real pixels.
    if (this.deps.actor) {
      const capture = input.captures.get(target.displayId);
      if (capture) {
        const cropped = this.cropFrame(capture.frame, [bx, by, bw, bh]);
        try {
          const refined = await this.deps.actor.ground({
            displayId: target.displayId,
            croppedImage: cropped,
            hint: brainOut.proposed_action.rationale,
            ref,
          });
          if (refined && Number.isFinite(refined.x) && Number.isFinite(refined.y)) {
            return {
              displayId: target.displayId,
              x: Math.round(refined.x),
              y: Math.round(refined.y),
            };
          }
        } catch (err) {
          logger.warn(
            `[computeruse/cascade] actor.ground failed for ref=${ref}: ${err instanceof Error ? err.message : String(err)} — using bbox center`,
          );
        }
      }
    }
    return { displayId: target.displayId, x: cx, y: cy };
  }

  private async groundRoi(
    input: CascadeInput,
    brainOut: BrainOutput,
    roi: BrainRoi,
  ): Promise<{ displayId: number; x: number; y: number } | null> {
    if (!this.deps.actor) return null;
    const capture = input.captures.get(roi.displayId);
    if (!capture) return null;
    const cropped = this.cropFrame(capture.frame, roi.bbox);
    const args: ActorGroundArgs = {
      displayId: roi.displayId,
      croppedImage: cropped,
      hint: brainOut.proposed_action.rationale,
      ref: brainOut.proposed_action.ref,
    };
    try {
      const grounded = await this.deps.actor.ground(args);
      if (!Number.isFinite(grounded.x) || !Number.isFinite(grounded.y)) {
        return null;
      }
      return {
        displayId: roi.displayId,
        x: Math.round(grounded.x),
        y: Math.round(grounded.y),
      };
    } catch (err) {
      logger.warn(
        `[computeruse/cascade] actor.ground threw for ROI: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private cropFrame(
    frame: Buffer,
    bbox: [number, number, number, number],
  ): Buffer {
    if (this.deps.crop) {
      return this.deps.crop(frame, bbox);
    }
    // No native PNG cropper in-tree. We pass the full frame through; the
    // built-in OcrCoordinateGroundingActor ignores the image anyway. When
    // a real Actor lands, the deps.crop callback should be injected.
    return frame;
  }
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Registry: register an Actor for the cascade to use globally. */
let _registeredActor: Actor | null = null;
export function setActor(actor: Actor | null): void {
  _registeredActor = actor;
}
export function getRegisteredActor(): Actor | null {
  return _registeredActor;
}
