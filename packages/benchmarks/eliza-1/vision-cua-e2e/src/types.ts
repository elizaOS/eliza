/**
 * Shared types for the eliza-1 vision + CUA E2E harness.
 *
 * Kept narrow on purpose: the harness consumes plugin-vision and
 * plugin-computeruse through their public interfaces (capture / tile / OCR /
 * IMAGE_DESCRIPTION). It does NOT depend on internal types from those
 * plugins so the harness can scaffold ahead of in-flight refactors landing
 * in parallel.
 */

export interface BBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayConfig {
  readonly id: number;
  readonly name: string;
  readonly bounds: readonly [number, number, number, number];
  readonly scaleFactor: number;
  readonly primary: boolean;
}

export interface DisplayCaptureFixture {
  readonly display: DisplayConfig;
  /** PNG bytes for the full display capture. */
  readonly frame: Uint8Array;
  /** PNG bytes for a follow-up capture used to detect state-change in stub mode. */
  readonly frameAfter: Uint8Array;
}

/** What the VLM is asked to ground inside a tile. */
export interface GroundingRequest {
  /** Free-text description of the UI element to locate. */
  readonly description: string;
  /** Tile id the model just looked at. */
  readonly tileId: string;
  /** Display id the tile came from. */
  readonly displayId: string;
}

/** Output from the VLM grounding step (tile-local coords). */
export interface GroundingResult {
  /** Tile-local bbox center the model believes the element sits at. */
  readonly tileLocalX: number;
  readonly tileLocalY: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** Tile id the result is anchored to. */
  readonly tileId: string;
  /** Display id the tile came from. */
  readonly displayId: string;
  /** Optional VLM-supplied bbox in tile-local coords. */
  readonly bbox?: BBox;
  /** Free-text justification — recorded in the trace. */
  readonly rationale?: string;
}

/** Absolute click target on a specific display. */
export interface AbsoluteClickTarget {
  readonly displayId: string;
  readonly absoluteX: number;
  readonly absoluteY: number;
}

/** A single pipeline-stage record in the trace JSON. */
export interface StageRecord {
  readonly stage: PipelineStage;
  readonly duration_ms: number;
  /** Compact human-readable summary of what the stage produced. */
  readonly output_summary: string;
  readonly displayId?: string;
  readonly ok: boolean;
  readonly error?: string;
}

export type PipelineStage =
  | "enumerate_displays"
  | "capture"
  | "tile"
  | "describe"
  | "ocr"
  | "ground"
  | "click"
  | "recapture"
  | "verify_state_change";

export interface DisplayRunRecord {
  readonly displayId: string;
  readonly displayName: string;
  readonly bounds: readonly [number, number, number, number];
  readonly scaleFactor: number;
  readonly primary: boolean;
  readonly tileCount: number;
  readonly stages: ReadonlyArray<StageRecord>;
  readonly clickTarget?: AbsoluteClickTarget;
  readonly stateChangeDetected: boolean;
}

export interface PipelineTrace {
  readonly run_id: string;
  readonly mode: "stub" | "real";
  readonly fixture_id: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly displays: ReadonlyArray<DisplayRunRecord>;
  readonly stages: ReadonlyArray<StageRecord>;
  readonly success: boolean;
  readonly failures: ReadonlyArray<string>;
}

export interface OcrCoordWord {
  readonly text: string;
  readonly bbox: BBox;
}

export interface OcrCoordBlock {
  readonly text: string;
  readonly bbox: BBox;
  readonly words: ReadonlyArray<OcrCoordWord>;
}

export interface OcrCoordResult {
  readonly blocks: ReadonlyArray<OcrCoordBlock>;
}

export interface VlmDescribeRequest {
  /** data URL or base64 PNG. */
  readonly imageUrl: string;
  /** JSON-encoded prompt with task + context. */
  readonly prompt: string;
}

export interface VlmDescribeResult {
  readonly description: string;
}
