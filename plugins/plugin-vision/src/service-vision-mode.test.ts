/** Covers the host-aware default for continuous camera processing. */
import { describe, expect, it } from "vitest";
import { resolveInitialVisionMode } from "./service";
import { VisionMode } from "./types";

describe("resolveInitialVisionMode", () => {
  it("defaults mobile runtimes to off so boot never requests camera access", () => {
    expect(resolveInitialVisionMode(undefined, "android")).toBe(VisionMode.OFF);
    expect(resolveInitialVisionMode(undefined, "ios")).toBe(VisionMode.OFF);
  });

  it("keeps the desktop camera default", () => {
    expect(resolveInitialVisionMode(undefined, "")).toBe(VisionMode.CAMERA);
    expect(resolveInitialVisionMode(undefined, "desktop")).toBe(
      VisionMode.CAMERA,
    );
    expect(resolveInitialVisionMode(undefined, "server")).toBe(
      VisionMode.CAMERA,
    );
  });

  it("honors every explicit valid mode on every platform", () => {
    for (const mode of Object.values(VisionMode)) {
      expect(resolveInitialVisionMode(mode, "android")).toBe(mode);
    }
  });
});
