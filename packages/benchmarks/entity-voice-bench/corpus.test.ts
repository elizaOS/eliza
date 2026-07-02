import { describe, expect, it } from "vitest";
import {
  allUtterances,
  type BenchUtterance,
  SESSIONS,
  SPEAKERS,
  speakerByKey,
} from "./corpus.ts";

/** Voice ids present in the Kokoro voice-pack registry (unknown ids fall back silently). */
const REGISTRY_VOICES = new Set([
  "af_same",
  "af_bella",
  "af_sarah",
  "af_nicole",
  "af_sky",
  "am_michael",
  "am_adam",
  "bf_emma",
  "bf_isabella",
  "bm_george",
  "bm_lewis",
]);

describe("entity-voice-bench corpus", () => {
  it("has 30-60 utterances with unique ids", () => {
    const utterances = allUtterances();
    expect(utterances.length).toBeGreaterThanOrEqual(30);
    expect(utterances.length).toBeLessThanOrEqual(60);
    const ids = new Set(utterances.map((u) => u.id));
    expect(ids.size).toBe(utterances.length);
  });

  it("covers every capability category with enough samples", () => {
    const byCategory = new Map<string, number>();
    for (const u of allUtterances()) {
      byCategory.set(u.category, (byCategory.get(u.category) ?? 0) + 1);
    }
    for (const category of [
      "recognition",
      "creation",
      "attribute",
      "disambiguation",
    ]) {
      expect(byCategory.get(category) ?? 0).toBeGreaterThanOrEqual(6);
    }
  });

  it("uses only registry Kokoro voices and multiple distinct voices", () => {
    const voices = new Set<string>();
    for (const speaker of SPEAKERS) {
      expect(REGISTRY_VOICES.has(speaker.voice)).toBe(true);
      voices.add(speaker.voice);
    }
    expect(voices.size).toBeGreaterThanOrEqual(6);
  });

  it("references only declared speakers and session members", () => {
    for (const session of SESSIONS) {
      for (const u of session.utterances) {
        expect(() => speakerByKey(u.speaker)).not.toThrow();
        expect(session.speakers).toContain(u.speaker);
      }
    }
  });

  it("orders profile-bound turns after the cluster's first appearance", () => {
    for (const session of SESSIONS) {
      const seen = new Set<string>();
      for (const u of session.utterances) {
        const speaker = speakerByKey(u.speaker);
        if (u.profileBound && !speaker.isOwner) {
          expect(seen.has(u.cluster)).toBe(true);
        }
        seen.add(u.cluster);
      }
    }
  });

  it("every expectBindsTo target has an earlier creation turn in-session", () => {
    for (const session of SESSIONS) {
      const created = new Set<string>();
      for (const u of session.utterances) {
        if (u.expectBindsTo) {
          expect(created.has(u.expectBindsTo)).toBe(true);
        }
        if (u.expectCreates && !speakerByKey(u.speaker).isOwner) {
          created.add(u.speaker);
        }
      }
    }
  });

  it("expectation fields sit on turns of the right category", () => {
    const check = (u: BenchUtterance) => {
      if (u.expectCreates) expect(u.category).toBe("creation");
      if (u.expectBindsTo) {
        expect(["recognition", "disambiguation"]).toContain(u.category);
      }
    };
    for (const u of allUtterances()) check(u);
  });
});
