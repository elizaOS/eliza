/**
 * Unit tests for voice status badge helper: validates ready message derivation.
 */
import { describe, expect, it } from "vitest";
import { getEstimatedReadyMessage } from "./voice-status-badge.helpers.ts";

describe("voice-status-badge.helpers", () => {
  it("returns instant ready message for instant clone type", () => {
    const msg = getEstimatedReadyMessage({
      cloneType: "instant",
      createdAt: new Date().toISOString(),
      name: "DemoVoice",
    });
    expect(msg).toBe('"DemoVoice" is ready to use.');
  });

  it("returns processing message for newly created professional voice", () => {
    const msg = getEstimatedReadyMessage({
      cloneType: "professional",
      createdAt: new Date().toISOString(),
      name: "StudioVoice",
    });
    expect(msg).toContain("is being processed");
    expect(msg).toContain("30-60 minutes");
  });

  it("returns ready soon/now message for older professional voice", () => {
    const past = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const msg = getEstimatedReadyMessage({
      cloneType: "professional",
      createdAt: past,
      name: "StudioVoice",
    });
    expect(msg).toContain("should be ready soon");
  });
});
