/**
 * Structured parameter resolvers for the VISION action (#10471).
 *
 * These are pure, dependency-light helpers deliberately kept out of `action.ts`
 * (which pulls in the image/OCR/sharp stack) so the operation + mode resolution
 * — the part that must NOT keyword-match raw message text — is independently
 * testable. The planner supplies the operation and mode as structured params;
 * these normalize them, never inferring intent from free text.
 */

import { VisionMode } from "./types";

export const VISION_OPS = [
  "describe",
  "capture",
  "get_screen",
  "set_mode",
  "enable_camera",
  "disable_camera",
  "enable_screen",
  "disable_screen",
  "name_entity",
  "identify_person",
  "track_entity",
] as const;

export type VisionOp = (typeof VISION_OPS)[number];

/**
 * Normalize a structured operation discriminator (`action`/`subaction`/`op`) to
 * a canonical `VisionOp`, accepting a documented alias set. Returns `null` for
 * anything unrecognized — including free-text sentences, so a raw message can
 * never be coerced into an op.
 */
export function normalizeOp(value: unknown): VisionOp | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  const aliases: Record<string, VisionOp> = {
    describe_scene: "describe",
    scene: "describe",
    capture_image: "capture",
    image: "capture",
    photo: "capture",
    snapshot: "capture",
    screenshot: "capture",
    set_vision_mode: "set_mode",
    mode: "set_mode",
    vision_mode: "set_mode",
    camera_on: "enable_camera",
    turn_on_camera: "enable_camera",
    start_camera: "enable_camera",
    camera_off: "disable_camera",
    turn_off_camera: "disable_camera",
    stop_camera: "disable_camera",
    screen_on: "enable_screen",
    turn_on_screen: "enable_screen",
    start_screen: "enable_screen",
    screen_off: "disable_screen",
    turn_off_screen: "disable_screen",
    stop_screen: "disable_screen",
    name: "name_entity",
    identify: "identify_person",
    recognize: "identify_person",
    track: "track_entity",
    follow: "track_entity",
  };
  if (aliases[normalized]) return aliases[normalized];
  return (VISION_OPS as readonly string[]).includes(normalized)
    ? (normalized as VisionOp)
    : null;
}

/**
 * Normalize a structured vision mode value (`set_mode` op) to a `VisionMode`.
 * Accepts the enum values + a small alias set; returns `null` for anything
 * unrecognized. Exact-match only — never a substring test on free text (#10471),
 * which previously let "coffee" match `.includes("off")` and disable vision.
 */
export function normalizeVisionMode(value: unknown): VisionMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, VisionMode> = {
    off: VisionMode.OFF,
    disable: VisionMode.OFF,
    disabled: VisionMode.OFF,
    none: VisionMode.OFF,
    stop: VisionMode.OFF,
    camera: VisionMode.CAMERA,
    screen: VisionMode.SCREEN,
    both: VisionMode.BOTH,
    all: VisionMode.BOTH,
  };
  return aliases[normalized] ?? null;
}
