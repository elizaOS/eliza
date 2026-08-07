/**
 * Covers the keyless-mode (#9577) speaker → Kokoro voice-pack mapping used by
 * the workbench real-services adapter. Pure logic, no fused lib required.
 */

import { describe, expect, it } from "vitest";
import {
	KOKORO_AGENT_VOICE,
	KOKORO_HUMAN_VOICE_IDS,
	KOKORO_VOICE_ALIASES,
	labelHash,
	resolveKokoroVoicePack,
} from "../workbench-voice-packs";

describe("resolveKokoroVoicePack", () => {
	it("maps scenario speaker labels to their aliased packs", () => {
		expect(resolveKokoroVoicePack(undefined, "owner")).toBe("af_bella");
		expect(resolveKokoroVoicePack(undefined, "intruder")).toBe("am_adam");
		expect(resolveKokoroVoicePack(undefined, "priya")).toBe("af_sarah");
	});

	it("prefers an explicit voiceId over the speaker label", () => {
		expect(resolveKokoroVoicePack("am_michael", "owner")).toBe("am_michael");
	});

	it("resolves keys case-insensitively", () => {
		expect(resolveKokoroVoicePack(undefined, "OWNER")).toBe("af_bella");
		expect(resolveKokoroVoicePack("AM_ADAM", "nobody-known")).toBe("am_adam");
	});

	it("falls through an unknown voiceId to the label alias", () => {
		expect(resolveKokoroVoicePack("not-a-pack", "marcus")).toBe("am_michael");
	});

	it("assigns unknown speakers a stable human pack", () => {
		const first = resolveKokoroVoicePack(undefined, "zephyr");
		const second = resolveKokoroVoicePack(undefined, "zephyr");
		expect(first).toBe(second);
		expect(KOKORO_HUMAN_VOICE_IDS).toContain(first);
	});

	it("never assigns the reserved agent pack to a human speaker", () => {
		// The echo scenarios measure the agent self-voice margin; a human turn
		// synthesized with the agent pack would collapse it by construction.
		expect(KOKORO_HUMAN_VOICE_IDS).not.toContain(KOKORO_AGENT_VOICE);
		for (const [alias, pack] of Object.entries(KOKORO_VOICE_ALIASES)) {
			expect(pack, `alias ${alias}`).not.toBe(KOKORO_AGENT_VOICE);
		}
		// Exhaustive over the hash fallback range too: every reachable pack for
		// arbitrary labels comes from KOKORO_HUMAN_VOICE_IDS.
		for (const label of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]) {
			expect(KOKORO_HUMAN_VOICE_IDS).toContain(
				resolveKokoroVoicePack(undefined, label),
			);
		}
	});

	it("keeps every alias target inside the human pack set", () => {
		for (const pack of Object.values(KOKORO_VOICE_ALIASES)) {
			expect(KOKORO_HUMAN_VOICE_IDS).toContain(pack);
		}
	});
});

describe("labelHash", () => {
	it("returns an unsigned 32-bit integer", () => {
		for (const label of ["", "owner", "guest", "Zephyr", "priya"]) {
			const h = labelHash(label);
			expect(Number.isInteger(h)).toBe(true);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThanOrEqual(0xffffffff);
		}
	});

	it("pins the FNV-1a offset basis for the empty string", () => {
		// A silent change of hash function would silently reshuffle every
		// unaliased speaker's voice between runs recorded before/after it.
		expect(labelHash("")).toBe(0x811c9dc5);
	});
});
