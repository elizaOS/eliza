/**
 * v0.2.0 — eliza fingerprint dictionary tests.
 *
 * Verifies that the eliza-derived dictionaries:
 *   1. Are non-empty and well-formed (every pair is a [string, string] tuple)
 *   2. Round-trip cleanly through forward + reverse maps
 *   3. Cover every tool name registered by `@elizaos/native-reasoning`
 *   4. Strip the CHANNEL_GAG_HARD_RULE block end-to-end
 */

import { describe, expect, it } from "vitest";
import {
	ELIZA_BOUNDARY_END,
	ELIZA_IDENTITY_MARKER,
	ELIZA_PROP_RENAMES,
	ELIZA_REPLACEMENTS,
	ELIZA_REVERSE_MAP,
	ELIZA_SYSTEM_CONFIG_PARAPHRASE,
	ELIZA_SYSTEM_PROMPT_PATTERNS,
	ELIZA_TOOL_RENAMES,
} from "../src/proxy/eliza-fingerprint.js";
import { applyReplacements } from "../src/proxy/sanitize.js";
import { stripSystemConfig } from "../src/proxy/system-prompt.js";
import { applyQuotedRenames } from "../src/proxy/tool-rename.js";

// Authoritative list extracted from
// @elizaos/native-reasoning/dist/tools/*.js — every `name: "..."`
// registered into the default tool registry.
const ELIZA_REGISTERED_TOOLS: readonly string[] = [
	"bash",
	"read_file",
	"write_file",
	"edit_file",
	"glob",
	"grep",
	"web_fetch",
	"web_search",
	"recall",
	"remember",
	"ignore",
	"journal",
	"note_thread",
	"close_thread",
	"update_project",
	"spawn_codex",
	"spawn_agent",
	"sessions_spawn",
];

describe("eliza fingerprint — shape", () => {
	it("ships non-empty dictionaries", () => {
		expect(ELIZA_REPLACEMENTS.length).toBeGreaterThan(0);
		expect(ELIZA_TOOL_RENAMES.length).toBeGreaterThan(0);
		expect(ELIZA_PROP_RENAMES.length).toBeGreaterThan(0);
		expect(ELIZA_REVERSE_MAP.length).toBeGreaterThan(0);
	});

	it("every tuple is [string, string]", () => {
		for (const dict of [
			ELIZA_REPLACEMENTS,
			ELIZA_TOOL_RENAMES,
			ELIZA_PROP_RENAMES,
			ELIZA_REVERSE_MAP,
		]) {
			for (const pair of dict) {
				expect(pair).toHaveLength(2);
				expect(typeof pair[0]).toBe("string");
				expect(typeof pair[1]).toBe("string");
				expect(pair[0].length).toBeGreaterThan(0);
				expect(pair[1].length).toBeGreaterThan(0);
			}
		}
	});

	it("forward and reverse string maps have aligned coverage", () => {
		const fwdKeys = new Set(ELIZA_REPLACEMENTS.map((p) => p[0]));
		const revKeys = new Set(ELIZA_REVERSE_MAP.map((p) => p[0]));
		// Every forward source must have a corresponding reverse-target entry.
		for (const k of fwdKeys) {
			expect(revKeys.has(k)).toBe(true);
		}
	});
});

describe("eliza fingerprint — tool coverage", () => {
	it("renames every tool registered by @elizaos/native-reasoning", () => {
		const renamedKeys = new Set(ELIZA_TOOL_RENAMES.map((p) => p[0]));
		const missing = ELIZA_REGISTERED_TOOLS.filter((t) => !renamedKeys.has(t));
		expect(missing).toEqual([]);
	});

	it("does not collide rename targets", () => {
		const targets = ELIZA_TOOL_RENAMES.map((p) => p[1]);
		const unique = new Set(targets);
		expect(targets.length).toBe(unique.size);
	});
});

describe("eliza fingerprint — string roundtrip", () => {
	it("forward then reverse on a high-signal eliza marker is lossless", () => {
		const samples = [
			"native-reasoning",
			"@elizaos/native-reasoning",
			"## Your Identity",
			"/workspace/journal/",
		];
		for (const s of samples) {
			const original = `prefix ${s} middle ${s} end`;
			const fwd = applyReplacements(original, ELIZA_REPLACEMENTS);
			const back = applyReplacements(fwd, ELIZA_REVERSE_MAP);
			expect(back).toBe(original);
		}
	});

	it("quoted tool rename swaps eliza name for CC-shaped name", () => {
		const sample = JSON.stringify({ tool: "bash", args: { cmd: "ls" } });
		const fwd = applyQuotedRenames(sample, ELIZA_TOOL_RENAMES);
		expect(fwd).toBe(JSON.stringify({ tool: "Bash", args: { cmd: "ls" } }));
	});
});

describe("eliza fingerprint — system prompt strip", () => {
	it("identifies and replaces the CHANNEL_GAG_HARD_RULE block", () => {
		// Synthetic system-prompt payload mimicking eliza's wire shape.
		const channelGagFull =
			ELIZA_IDENTITY_MARKER +
			' (e.g., "nyx stay quiet", "nyx be quiet", "nyx shut up", "stay silent"), DO NOT' +
			" respond on subsequent messages in that channel until they explicitly say you can" +
			' speak again ("nyx you can speak", "nyx unmute", etc). This applies even if you' +
			" think you have something useful to say. The only exception is if a different" +
			" human in the channel explicitly addresses you. " + ELIZA_BOUNDARY_END;
		const wirePayload = `{"system":[{"type":"text","text":"You are nyx.\\n${channelGagFull}\\nMore content here."}]}`;
		const result = stripSystemConfig(wirePayload);
		expect(result.stripped).toBeGreaterThan(0);
		expect(result.body).not.toContain(ELIZA_IDENTITY_MARKER);
		expect(result.body).not.toContain(ELIZA_BOUNDARY_END);
		expect(result.body).toContain("You are nyx.");
		expect(result.body).toContain("More content here.");
	});

	it("no-ops when the eliza marker is not present", () => {
		const wirePayload = `{"system":[{"type":"text","text":"You are some other bot."}]}`;
		const result = stripSystemConfig(wirePayload);
		expect(result.stripped).toBe(0);
		expect(result.body).toBe(wirePayload);
	});

	it("no-ops on a too-short marker run (defensive against partial matches)", () => {
		const wirePayload = `{"system":[{"type":"text","text":"${ELIZA_IDENTITY_MARKER} ${ELIZA_BOUNDARY_END}"}]}`;
		// This is shorter than MIN_STRIP_LEN, should no-op.
		const result = stripSystemConfig(wirePayload);
		expect(result.stripped).toBe(0);
	});
});

describe("eliza fingerprint — patterns", () => {
	it("CHANNEL_GAG_HARD_RULE is matched by ELIZA_SYSTEM_PROMPT_PATTERNS", () => {
		const sample = `${ELIZA_IDENTITY_MARKER} ${ELIZA_BOUNDARY_END}`;
		for (const re of ELIZA_SYSTEM_PROMPT_PATTERNS) {
			expect(re.test(sample)).toBe(true);
		}
	});

	it("paraphrase preserves muting semantics keyword 'stay quiet'", () => {
		expect(ELIZA_SYSTEM_CONFIG_PARAPHRASE.toLowerCase()).toContain("stay quiet");
	});
});
