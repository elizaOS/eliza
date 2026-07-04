/**
 * Deterministic unit coverage for `outboundDraftOptionsFromMessage`, the MESSAGE
 * action's outbound-field extraction. Stubs `runtime.useModel` (no live model)
 * to prove the model is consulted only when structured params are incomplete,
 * its XML is parsed into the draft, and a model failure degrades to no guessed
 * fields.
 */
import { describe, expect, it, vi } from "vitest";

import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
} from "../../../../types/index.ts";
import { outboundDraftOptionsFromMessage } from "./sendDraft.ts";

/**
 * #10470: the `MESSAGE` action extracts the outbound platform/recipient/body via
 * the model's structured output instead of English-only regex. These tests cover
 * the WIRING — that the model is invoked only when the structured params are
 * incomplete, its output is parsed into the draft, and a model failure degrades
 * gracefully. The model's extraction QUALITY (incl. non-English) is proven by the
 * live-model trajectory in
 * `.github/issue-evidence/10470-llm-driven-actions/sendDraft-extraction.md`,
 * not by these stubs.
 */
function msg(text: string): Memory {
	return { content: { text } } as Memory;
}
function params(p: Record<string, unknown>): HandlerOptions {
	return { parameters: p } as HandlerOptions;
}

describe("sendDraft outboundDraftOptionsFromMessage — structured extraction wiring (#10470)", () => {
	it("invokes the model to fill missing fields and parses its structured output", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValue(
				"<source>whatsapp</source>\n<recipient>Ana</recipient>\n<body>llego en 5 minutos</body>",
			);
		const runtime = { useModel } as unknown as IAgentRuntime;

		const out = await outboundDraftOptionsFromMessage(
			runtime,
			msg("envíale a Ana un WhatsApp diciendo que llego en 5 minutos"),
			undefined,
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(out?.parameters).toMatchObject({
			source: "whatsapp",
			body: "llego en 5 minutos",
			to: ["Ana"],
		});
	});

	it("does NOT call the model when the structured params are already complete (cheap fast path)", async () => {
		const useModel = vi.fn().mockResolvedValue("<source>telegram</source>");
		const runtime = { useModel } as unknown as IAgentRuntime;

		const out = await outboundDraftOptionsFromMessage(
			runtime,
			msg("ignored — params already structured"),
			params({ source: "telegram", body: "hi", to: ["Bob"] }),
		);

		expect(useModel).not.toHaveBeenCalled();
		expect(out?.parameters).toMatchObject({
			source: "telegram",
			body: "hi",
			to: ["Bob"],
		});
	});

	it("still extracts when only SOME params are present (model fills the gaps)", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValue(
				"<source>telegram</source>\n<recipient>Bob</recipient>\n<body>running late</body>",
			);
		const runtime = { useModel } as unknown as IAgentRuntime;

		// source provided, but recipient + body missing → model is consulted.
		const out = await outboundDraftOptionsFromMessage(
			runtime,
			msg("tell Bob I'm running late on telegram"),
			params({ source: "telegram" }),
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(out?.parameters).toMatchObject({
			source: "telegram",
			body: "running late",
			to: ["Bob"],
		});
	});

	it("degrades gracefully (no guessed fields) when the model call fails", async () => {
		const useModel = vi.fn().mockRejectedValue(new Error("model unavailable"));
		const runtime = { useModel } as unknown as IAgentRuntime;

		const out = await outboundDraftOptionsFromMessage(
			runtime,
			msg("send something to someone"),
			undefined,
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(out?.parameters?.source).toBeUndefined();
		expect(out?.parameters?.body).toBeUndefined();
		expect(out?.parameters?.to).toBeUndefined();
	});
});
