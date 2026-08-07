/** Covers the `KOKORO_VOICE_PACKS` catalog invariants. Deterministic. */
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

	it("contains the complete upstream English v1.0 voice set", () => {
		expect(listKokoroVoiceIds()).toEqual(
			expect.arrayContaining([
				"af_heart",
				"af_alloy",
				"af_aoede",
				"af_bella",
				"af_jessica",
				"af_kore",
				"af_nicole",
				"af_nova",
				"af_river",
				"af_sarah",
				"af_sky",
				"am_adam",
				"am_echo",
				"am_eric",
				"am_fenrir",
				"am_liam",
				"am_michael",
				"am_onyx",
				"am_puck",
				"am_santa",
				"bf_alice",
				"bf_emma",
				"bf_isabella",
				"bf_lily",
				"bm_daniel",
				"bm_fable",
				"bm_george",
				"bm_lewis",
			]),
		);
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
