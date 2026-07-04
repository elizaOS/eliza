/** Covers Kokoro voice-backend selection and env-mode parsing. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	readVoiceBackendModeFromEnv,
	selectVoiceBackend,
} from "../runtime-selection";

// OmniVoice TTS was retired — Kokoro is the only on-device TTS backend, so the
// selector collapses to a single answer: Kokoro when its artifacts are present,
// else a hard error (never a silent downgrade).
describe("selectVoiceBackend", () => {
	it("returns Kokoro when artifacts are present", () => {
		const d = selectVoiceBackend({ kokoroAvailable: true });
		expect(d.backend).toBe("kokoro");
		expect(d.reason).toMatch(/Kokoro/);
	});

	it("returns Kokoro on mobile", () => {
		const d = selectVoiceBackend({ mobile: true, kokoroAvailable: true });
		expect(d.backend).toBe("kokoro");
		expect(d.reason).toMatch(/mobile/);
	});

	it("returns Kokoro regardless of mode (kokoro and auto both resolve to Kokoro)", () => {
		expect(
			selectVoiceBackend({ mode: "kokoro", kokoroAvailable: true }).backend,
		).toBe("kokoro");
		expect(
			selectVoiceBackend({ mode: "auto", kokoroAvailable: true }).backend,
		).toBe("kokoro");
	});

	it("throws when Kokoro artifacts are missing — no fallback", () => {
		expect(() => selectVoiceBackend({ kokoroAvailable: false })).toThrow(
			/Kokoro model artifacts are not present/,
		);
		expect(() =>
			selectVoiceBackend({ mobile: true, kokoroAvailable: false }),
		).toThrow(/Kokoro model artifacts are not present/);
	});
});

describe("readVoiceBackendModeFromEnv", () => {
	it("parses 'kokoro' and 'auto'", () => {
		expect(readVoiceBackendModeFromEnv({ ELIZA_TTS_BACKEND: "kokoro" })).toBe(
			"kokoro",
		);
		expect(readVoiceBackendModeFromEnv({ ELIZA_TTS_BACKEND: "AUTO" })).toBe(
			"auto",
		);
	});

	it("returns undefined when unset", () => {
		expect(readVoiceBackendModeFromEnv({})).toBeUndefined();
	});

	it("rejects the retired 'omnivoice' value with a migration message", () => {
		expect(() =>
			readVoiceBackendModeFromEnv({ ELIZA_TTS_BACKEND: "omnivoice" }),
		).toThrow(/retired/);
	});

	it("rejects any other value", () => {
		expect(() =>
			readVoiceBackendModeFromEnv({ ELIZA_TTS_BACKEND: "bogus" }),
		).toThrow(/must be 'kokoro' or 'auto'/);
	});
});
