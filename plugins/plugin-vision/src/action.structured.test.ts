/**
 * Structured-parameter tests for VISION action operation and mode normalization.
 *
 * These pin planner-provided params as the source of truth and prevent raw
 * message substring matching from reappearing.
 */

import { describe, expect, it } from "vitest";
import { normalizeOp, normalizeVisionMode } from "./action-params";
import { VisionMode } from "./types";

describe("normalizeOp (structured op only)", () => {
  it("accepts canonical ops", () => {
    expect(normalizeOp("describe")).toBe("describe");
    expect(normalizeOp("set_mode")).toBe("set_mode");
    expect(normalizeOp("track_entity")).toBe("track_entity");
  });

  it("accepts documented aliases", () => {
    expect(normalizeOp("screenshot")).toBe("capture");
    expect(normalizeOp("photo")).toBe("capture");
    expect(normalizeOp("scene")).toBe("describe");
    expect(normalizeOp("turn_on_camera")).toBe("enable_camera");
    expect(normalizeOp("identify")).toBe("identify_person");
  });

  it("normalizes spacing/casing/hyphens", () => {
    expect(normalizeOp(" Set-Mode ")).toBe("set_mode");
    expect(normalizeOp("TURN OFF CAMERA")).toBe("disable_camera");
  });

  it("rejects free-text sentences (no keyword inference)", () => {
    expect(normalizeOp("please describe what you see on my screen")).toBeNull();
    expect(normalizeOp("can you take a photo?")).toBeNull();
    expect(normalizeOp("")).toBeNull();
    expect(normalizeOp(undefined)).toBeNull();
    expect(normalizeOp(42)).toBeNull();
  });
});

describe("normalizeVisionMode (exact enum match, no substring bug)", () => {
  it("maps enum values and aliases", () => {
    expect(normalizeVisionMode("OFF")).toBe(VisionMode.OFF);
    expect(normalizeVisionMode("disable")).toBe(VisionMode.OFF);
    expect(normalizeVisionMode("camera")).toBe(VisionMode.CAMERA);
    expect(normalizeVisionMode("screen")).toBe(VisionMode.SCREEN);
    expect(normalizeVisionMode("both")).toBe(VisionMode.BOTH);
    expect(normalizeVisionMode(" Both ")).toBe(VisionMode.BOTH);
  });

  it("does NOT match a substring — the old bug where 'coffee'→OFF is gone", () => {
    // "coffee" contains the substring "off"; exact-match must reject it.
    expect(normalizeVisionMode("coffee")).toBeNull();
    expect(normalizeVisionMode("turn off the lights and set alarm")).toBeNull();
    expect(normalizeVisionMode("screenshot please")).toBeNull();
    expect(normalizeVisionMode("")).toBeNull();
    expect(normalizeVisionMode(undefined)).toBeNull();
  });
});
