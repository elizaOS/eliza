import { describe, expect, it } from "vitest";
import {
  compareVoiceModelSemver,
  findVoiceModelVersion,
  latestVoiceModelVersion,
  VOICE_MODEL_VERSIONS,
  type VoiceModelId,
  versionsFor,
} from "./voice-models.js";

describe("compareVoiceModelSemver", () => {
  it("orders major.minor.patch", () => {
    expect(compareVoiceModelSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareVoiceModelSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVoiceModelSemver("1.1.0", "1.0.9")).toBe(1);
    expect(compareVoiceModelSemver("2.0.0", "1.99.99")).toBe(1);
  });

  it("treats released > pre-release at the same core version", () => {
    expect(compareVoiceModelSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVoiceModelSemver("1.0.0-beta", "1.0.0")).toBe(-1);
  });

  it("compares pre-release identifiers per semver 2.0.0 §11", () => {
    // numeric vs numeric: numeric compare
    expect(compareVoiceModelSemver("1.0.0-1", "1.0.0-2")).toBe(-1);
    expect(compareVoiceModelSemver("1.0.0-10", "1.0.0-9")).toBe(1);
    // numeric < alphanumeric within the same field
    expect(compareVoiceModelSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    // shorter pre-release < longer with same prefix
    expect(compareVoiceModelSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    // alphabetical
    expect(compareVoiceModelSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
  });

  it("returns null on garbage input", () => {
    expect(compareVoiceModelSemver("not-a-version", "1.0.0")).toBeNull();
    expect(compareVoiceModelSemver("1.0", "1.0.0")).toBeNull();
    expect(compareVoiceModelSemver("v1.0.0", "1.0.0")).toBeNull();
  });
});

describe("VOICE_MODEL_VERSIONS bookkeeping", () => {
  it("ships at least one version per declared model id", () => {
    const expectedIds: ReadonlyArray<VoiceModelId> = [
      "speaker-encoder",
      "diarizer",
      "turn-detector",
      "voice-emotion",
      "kokoro",
      "omnivoice",
      "vad",
      "wakeword",
      "embedding",
      "asr",
    ];
    for (const id of expectedIds) {
      const hits = VOICE_MODEL_VERSIONS.filter((v) => v.id === id);
      expect(hits.length, `missing entries for ${id}`).toBeGreaterThanOrEqual(
        1,
      );
    }
  });

  it("every version has a valid semver string", () => {
    const semver = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
    for (const v of VOICE_MODEL_VERSIONS) {
      expect(v.version, `${v.id}@${v.version}`).toMatch(semver);
    }
  });

  it("every version has a hf repo + revision + non-empty changelog entry", () => {
    for (const v of VOICE_MODEL_VERSIONS) {
      expect(v.hfRepo, `${v.id}@${v.version}`).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(v.hfRevision.length, `${v.id}@${v.version}`).toBeGreaterThan(0);
      expect(v.changelogEntry.trim().length).toBeGreaterThan(0);
    }
  });

  it("publishedToHfAt is an ISO-8601 timestamp", () => {
    for (const v of VOICE_MODEL_VERSIONS) {
      expect(Number.isFinite(Date.parse(v.publishedToHfAt))).toBe(true);
    }
  });

  it("does not ship placeholder asset hashes", () => {
    const sha = /^[0-9a-f]{64}$/;
    for (const v of VOICE_MODEL_VERSIONS) {
      for (const asset of v.ggufAssets) {
        expect(asset.sha256, `${v.id}@${v.version}:${asset.filename}`).toMatch(
          sha,
        );
        expect(
          asset.sha256,
          `${v.id}@${v.version}:${asset.filename}`,
        ).not.toContain("TBD");
        expect(asset.sizeBytes).toBeGreaterThan(0);
      }
      for (const asset of v.missingAssets ?? []) {
        expect(asset.filename.length).toBeGreaterThan(0);
        expect(asset.reason).toMatch(/^missing-from-/);
      }
    }
  });
});

describe("versionsFor / latestVoiceModelVersion / findVoiceModelVersion", () => {
  it("versionsFor sorts latest first", () => {
    const all = versionsFor("kokoro");
    expect(all.length).toBeGreaterThan(0);
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur = all[i];
      if (!prev || !cur) continue;
      const cmp = compareVoiceModelSemver(prev.version, cur.version);
      expect(cmp).not.toBe(-1); // prev >= cur
    }
  });

  it("latestVoiceModelVersion is the head of versionsFor", () => {
    const latest = latestVoiceModelVersion("speaker-encoder");
    expect(latest).toBeDefined();
    const all = versionsFor("speaker-encoder");
    expect(latest).toBe(all[0]);
  });

  it("findVoiceModelVersion returns undefined for missing version", () => {
    expect(findVoiceModelVersion("kokoro", "99.99.99")).toBeUndefined();
    expect(findVoiceModelVersion("kokoro", "0.1.0")).toBeDefined();
  });
});
