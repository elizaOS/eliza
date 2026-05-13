import { describe, expect, it } from "vitest";
import {
  findKokoroVoice,
  KOKORO_DEFAULT_VOICE_ID,
  KOKORO_VOICE_PACKS,
  listKokoroVoiceIds,
  listKokoroVoicesByLang,
  listKokoroVoicesByTag,
  resolveKokoroVoiceOrDefault,
} from "../voices";

describe("KOKORO_VOICE_PACKS", () => {
  it("is non-empty and every entry has consistent metadata", () => {
    expect(KOKORO_VOICE_PACKS.length).toBeGreaterThanOrEqual(8);
    for (const v of KOKORO_VOICE_PACKS) {
      expect(v.id).toMatch(/^[a-z]{2}_[a-z]+$/);
      expect(v.file).toBe(`${v.id}.bin`);
      expect(v.dim).toBe(256);
      expect(["a", "b"]).toContain(v.lang);
      expect(v.displayName.length).toBeGreaterThan(0);
    }
  });

  it("default voice id is registered", () => {
    expect(findKokoroVoice(KOKORO_DEFAULT_VOICE_ID)).toBeDefined();
  });

  it("ids are unique", () => {
    const ids = listKokoroVoiceIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("listKokoroVoicesByLang filters correctly", () => {
    const us = listKokoroVoicesByLang("a");
    const uk = listKokoroVoicesByLang("b");
    expect(us.length).toBeGreaterThan(0);
    expect(uk.length).toBeGreaterThan(0);
    expect(us.every((v) => v.lang === "a")).toBe(true);
    expect(uk.every((v) => v.lang === "b")).toBe(true);
  });

  it("listKokoroVoicesByTag filters by tag membership", () => {
    const female = listKokoroVoicesByTag("female");
    expect(female.length).toBeGreaterThan(0);
    expect(female.every((v) => v.tags?.includes("female"))).toBe(true);
  });

  it("resolveKokoroVoiceOrDefault returns the requested voice when present", () => {
    const v = resolveKokoroVoiceOrDefault("af_sarah");
    expect(v.id).toBe("af_sarah");
  });

  it("resolveKokoroVoiceOrDefault falls back to the default for unknown ids", () => {
    const v = resolveKokoroVoiceOrDefault("not_a_real_voice_id");
    expect(v.id).toBe(KOKORO_DEFAULT_VOICE_ID);
  });
});
