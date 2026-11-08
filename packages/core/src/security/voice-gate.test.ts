/**
 * The voice gate rephrases through `useModel`, which swaps contacts, secrets
 * and PII into placeholders and surrogates before the provider sees them. The
 * rewrite must come back to the user with the real values, never a swap token,
 * and only restored text may be cached.
 *
 * Drives a real AgentRuntime with both swaps on and a TEXT_SMALL handler that
 * stands in for the provider.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it, vi } from "vitest";
import type { Character } from "../types/agent.ts";
import { ModelType } from "../types/model.ts";
import { ensureAgentVoice } from "./voice-gate.ts";

const PHONE = "415-555-2671";
const EMAIL = "pat@example.com";
const ADDRESS = "123 Main Street";
const RAW = `Your pickup is at ${ADDRESS}, call ${PHONE} or email ${EMAIL}`;

/** The message as the provider received it, i.e. echoed back in swap space. */
function echoMessage(prompt: string): string {
	return prompt
		.split("Message to rewrite:\n")[1]
		.split("\n\nRewritten message:")[0];
}

function swapRuntime(reply: (prompt: string) => string) {
	const runtime = createSQLiteTestRuntime({
		character: {
			name: "VoiceGate",
			bio: "test",
			settings: {
				ELIZA_SECRET_SWAP_ENABLED: "true",
				ELIZA_PII_SWAP_ENABLED: "true",
			},
		} as Character,
		logLevel: "fatal",
	});
	const prompts: string[] = [];
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		async (_runtime, params) => {
			const prompt = String((params as { prompt?: unknown }).prompt);
			prompts.push(prompt);
			return reply(prompt);
		},
		"voice-gate-test-provider",
	);
	const reportError = vi.fn();
	runtime.reportError = reportError as typeof runtime.reportError;
	return { runtime, prompts, reportError };
}

describe("ensureAgentVoice with swaps enabled", () => {
	it("restores the real values into the rewrite and into the cached copy", async () => {
		const { runtime, prompts, reportError } = swapRuntime(echoMessage);

		const first = await ensureAgentVoice(
			runtime,
			{ text: RAW },
			{ source: "voice-gate-restore" },
		);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).not.toContain(PHONE);
		expect(prompts[0]).not.toContain(EMAIL);
		expect(prompts[0]).not.toContain(ADDRESS);
		expect(first.agentVoiced).toBe(true);
		expect(first.text).toBe(RAW);
		expect(first.text).not.toContain("__ELIZA_");

		const second = await ensureAgentVoice(
			runtime,
			{ text: RAW },
			{ source: "voice-gate-restore" },
		);
		expect(prompts).toHaveLength(1);
		expect(second.text).toBe(first.text);
		expect(second.agentVoiced).toBe(true);
		expect(reportError).not.toHaveBeenCalled();
	});

	it("delivers the raw literal and caches nothing when a placeholder cannot be restored", async () => {
		const { runtime, prompts, reportError } = swapRuntime(
			() => "Grab it soon, ring __ELIZA_CONTACT_deadbeef_1__ when you arrive",
		);

		const first = await ensureAgentVoice(
			runtime,
			{ text: RAW },
			{ source: "voice-gate-unrestorable" },
		);
		expect(first.text).toBe(RAW);
		expect(first.agentVoiced).toBeUndefined();
		expect(reportError).toHaveBeenCalledTimes(1);

		await ensureAgentVoice(
			runtime,
			{ text: RAW },
			{ source: "voice-gate-unrestorable" },
		);
		expect(prompts).toHaveLength(2);
	});
});
