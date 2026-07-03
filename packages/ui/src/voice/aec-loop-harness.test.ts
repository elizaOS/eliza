/**
 * `#aec-loop?...` hash-trigger parsing for the on-device AEC evidence harness
 * (#11373). The acoustic loop itself is device-only (getUserMedia + Web Audio
 * + the on-device agent); what is unit-testable is the trigger contract the
 * `elizaos://aec-loop?...` deep link relies on.
 */

import { describe, expect, it } from "vitest";
import { parseAecLoopHash } from "./aec-loop-harness";

describe("parseAecLoopHash (#11373)", () => {
  it("returns null for unrelated hashes", () => {
    expect(parseAecLoopHash("")).toBeNull();
    expect(parseAecLoopHash("#chat?voice=1")).toBeNull();
    expect(parseAecLoopHash("#aec-loops")).toBeNull();
    expect(parseAecLoopHash("#aec-loop-extra")).toBeNull();
  });

  it("matches the bare route with defaults", () => {
    expect(parseAecLoopHash("#aec-loop")).toEqual({});
    expect(parseAecLoopHash("#/aec-loop")).toEqual({});
  });

  it("parses run options from the query", () => {
    const options = parseAecLoopHash(
      "#aec-loop?tag=double-talk&maxSeconds=25&tailMs=3000&warmupMs=500&text=hello%20there&pagePcm=0",
    );
    expect(options).toEqual({
      tag: "double-talk",
      maxSeconds: 25,
      tailMs: 3000,
      warmupMs: 500,
      ttsText: "hello there",
      includePagePcm: false,
    });
  });

  it("ignores malformed numeric params", () => {
    expect(
      parseAecLoopHash("#aec-loop?maxSeconds=abc&tailMs=-5&warmupMs=nope"),
    ).toEqual({});
  });
});
