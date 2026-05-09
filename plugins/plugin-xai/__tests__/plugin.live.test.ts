/**
 * Live e2e for plugin-xai. Calls the plugin's TEXT_LARGE handler against the
 * real xAI Grok API and verifies:
 *   - a real generation succeeds and contains the expected math answer
 *   - the runtime emits `MODEL_USED` with non-zero prompt/completion token
 *     counts sourced from the upstream usage payload
 *
 * Skips with a yellow warning when `XAI_API_KEY` is not set. xAI is not a
 * supported provider in the shared `describeLive` helper, so this suite
 * uses an inline minimal runtime that satisfies the bits the model handler
 * actually touches (`getSetting`, `emitEvent`, `character`, plus enough of
 * the trajectory plumbing for `recordLlmCall` to no-op cleanly).
 */
import {
	type EventPayload,
	type IAgentRuntime,
	ModelType,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { XAIPlugin } from "../index";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const REQUIRED = ["XAI_API_KEY"] as const;

const missing = REQUIRED.filter((k) => !process.env[k]?.trim());

interface CapturedEvent {
	type: string;
	payload: EventPayload;
}

function createInlineRuntime(captured: CapturedEvent[]): IAgentRuntime {
	const settings: Record<string, string | undefined> = {
		XAI_API_KEY: process.env.XAI_API_KEY,
		XAI_BASE_URL: process.env.XAI_BASE_URL,
		XAI_LARGE_MODEL: process.env.XAI_LARGE_MODEL,
		XAI_SMALL_MODEL: process.env.XAI_SMALL_MODEL,
	};
	return {
		character: { name: "LiveXaiTest", system: "You are concise." },
		getSetting: (key: string) => settings[key],
		emitEvent: async (
			type: string | string[],
			payload: EventPayload,
		): Promise<void> => {
			const types = Array.isArray(type) ? type : [type];
			for (const t of types) captured.push({ type: t, payload });
		},
		getService: () => null,
		getServicesByType: () => [],
	} as IAgentRuntime;
}

if (missing.length > 0) {
	const reason = `missing required env: ${missing.join(", ")}`;
	process.env.SKIP_REASON ||= reason;
	console.warn(
		`${YELLOW}[plugin-xai live] skipped — ${reason} (set ${missing.join(
			", ",
		)} to enable)${RESET}`,
	);
	describe("xai live MODEL_USED events", () => {
		it.skip(`[live] suite skipped — set ${missing.join(", ")} to enable`, () => {});
	});
} else {
	describe("xai live MODEL_USED events", () => {
		it(
			"emits real prompt/completion token counts for TEXT_LARGE and returns the expected answer",
			async () => {
				const captured: CapturedEvent[] = [];
				const runtime = createInlineRuntime(captured);
				const handler = XAIPlugin.models?.[ModelType.TEXT_LARGE];
				expect(handler).toBeDefined();

				const result = await handler?.(runtime, {
					prompt:
						"What is 2+2? Reply with only the digit and nothing else.",
					maxTokens: 16,
				});

				expect(typeof result).toBe("string");
				expect(String(result)).toContain("4");

				const modelUsed = captured.find((e) => e.type === "MODEL_USED");
				expect(modelUsed).toBeDefined();
				const payload = modelUsed?.payload as Record<string, unknown>;
				expect(payload.source).toBe("xai");
				expect(payload.provider).toBe("xai");
				expect(payload.type).toBe("TEXT_LARGE");
				expect(typeof payload.model).toBe("string");
				const tokens = payload.tokens as {
					prompt: number;
					completion: number;
					total: number;
				};
				expect(tokens.prompt).toBeGreaterThan(0);
				expect(tokens.completion).toBeGreaterThan(0);
				expect(tokens.total).toBeGreaterThanOrEqual(
					tokens.prompt + tokens.completion - 1,
				);
			},
			120_000,
		);
	});
}
