/**
 * Contract-table invariants: the constant tables (targets, prerequisites,
 * auto-start set) cover every intent type exactly, and the auto-start/prereq
 * shapes match the design (only mic-starting intents are consent-gated; every
 * stop-* is prerequisite-free so it stays reversible). Deterministic; no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_START_INTENT_TYPES,
  INTENT_PREREQUISITES,
  INTENT_TARGET,
  OS_INTENT_TYPES,
} from "./contract";

describe("os-intent contract tables", () => {
  it("assigns a target to every intent type and nothing extra", () => {
    expect(Object.keys(INTENT_TARGET).sort()).toEqual(
      [...OS_INTENT_TYPES].sort(),
    );
  });

  it("declares prerequisites for every intent type", () => {
    expect(Object.keys(INTENT_PREREQUISITES).sort()).toEqual(
      [...OS_INTENT_TYPES].sort(),
    );
  });

  it("marks exactly the two mic-starting intents as auto-start", () => {
    expect([...AUTO_START_INTENT_TYPES].sort()).toEqual([
      "start-transcription",
      "start-voice",
    ]);
  });

  it("gives every stop-* intent zero prerequisites (always reversible)", () => {
    expect(INTENT_PREREQUISITES["stop-voice"]).toEqual([]);
    expect(INTENT_PREREQUISITES["stop-transcription"]).toEqual([]);
  });

  it("requires voice-capture on exactly the auto-start intents", () => {
    for (const type of OS_INTENT_TYPES) {
      const needsCapture = INTENT_PREREQUISITES[type].includes("voice-capture");
      expect(needsCapture).toBe(AUTO_START_INTENT_TYPES.has(type));
    }
  });
});
