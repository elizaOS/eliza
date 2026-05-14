/**
 * WS7 — Shared types for Brain / Actor / Cascade / Dispatch.
 *
 * These are the JSON contracts the planner and the cascade exchange. The
 * Brain MUST emit `BrainOutput`; the cascade resolves it into a concrete
 * `ProposedAction` with display-local OS-pixel coords; the dispatcher
 * validates and forwards it through `ComputerInterface`.
 */

import type { SceneAxNode, SceneOcrBox } from "../scene/scene-types.js";

export type BrainActionKind =
  | "click"
  | "double_click"
  | "right_click"
  | "type"
  | "hotkey"
  | "key"
  | "scroll"
  | "drag"
  | "wait"
  | "finish";

export interface BrainRoi {
  displayId: number;
  /** [x, y, w, h] in DISPLAY-LOCAL pixel space. */
  bbox: [number, number, number, number];
  reason: string;
}

export interface BrainProposedAction {
  kind: BrainActionKind;
  /** Stable id of an OCR box (`t<displayId>-<seq>`) or AX node (`a<displayId>-<seq>`). */
  ref?: string;
  /**
   * Action-specific args. For `type`: { text }. For `hotkey`: { keys }. For
   * `key`: { key }. For `scroll`: { dx, dy }. For `drag`: { from: {x,y}, to:
   * {x,y} }. Coordinates here are display-local pixel space.
   */
  args?: Record<string, unknown>;
  rationale: string;
}

export interface BrainOutput {
  scene_summary: string;
  target_display_id: number;
  /** Up to N (cap enforced by cascade) ROIs the Brain wants the Actor to ground. */
  roi: BrainRoi[];
  proposed_action: BrainProposedAction;
}

/**
 * Concrete action after the cascade has resolved coords. The dispatcher
 * accepts only this shape.
 */
export interface ProposedAction {
  kind: BrainActionKind;
  displayId: number;
  /** Display-local pixel coords, resolved by the cascade. */
  x?: number;
  y?: number;
  /** For drag: start point. */
  startX?: number;
  startY?: number;
  text?: string;
  key?: string;
  keys?: string[];
  dx?: number;
  dy?: number;
  ref?: string;
  rationale: string;
}

export interface ActionResult {
  success: boolean;
  /** Structured error code; absent on success. */
  error?: {
    code:
      | "unknown_display"
      | "out_of_bounds"
      | "invalid_args"
      | "driver_error"
      | "brain_error"
      | "actor_error"
      | "timeout"
      | "internal";
    message: string;
  };
  /** Action that was actually issued (mirrors input on success). */
  issued?: ProposedAction;
}

export interface CascadeResult {
  scene_summary: string;
  proposed: ProposedAction;
  /** ROIs the Brain produced, kept for trajectory logging. */
  rois: BrainRoi[];
}

/**
 * What the Actor returns when grounding a ROI / ref to a coord.
 * `coords` are display-local pixel space.
 */
export interface GroundingResult {
  displayId: number;
  x: number;
  y: number;
  /** 0..1 confidence — informational only; the dispatcher does not gate on it. */
  confidence: number;
  /** Human-readable explanation, for trajectory + retries. */
  reason: string;
}

/** Picked OCR/AX target — used by the deterministic OCR/AX grounding actor. */
export interface ReferenceTarget {
  displayId: number;
  bbox: [number, number, number, number];
  kind: "ocr" | "ax";
  label: string;
  source: SceneOcrBox | SceneAxNode;
}
