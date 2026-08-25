/**
 * Verifies model-assisted Discord splitting is accepted only when every
 * source code unit remains recoverable in order.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { sendMessageInChunks, smartSplitMessage, splitMessage } from "../utils";

function runtimeReturning(response: string): IAgentRuntime {
	return {
		logger: { debug: vi.fn() },
		useModel: vi.fn(async () => response),
	} as unknown as IAgentRuntime;
}

describe("smartSplitMessage lossless validation", () => {
	it("accepts a complete exact model projection", async () => {
		const source = "abcdefghijk";
		const chunks = await smartSplitMessage(
			runtimeReturning(JSON.stringify(["abcdef", "ghijk"])),
			source,
			6,
		);
		expect(chunks).toEqual(["abcdef", "ghijk"]);
	});

	it("rejects a projection that reflows boundary whitespace", async () => {
		const source = "abc def\nghijk";
		const chunks = await smartSplitMessage(
			runtimeReturning(JSON.stringify(["abc def", "ghijk"])),
			source,
			7,
		);
		expect(chunks).toEqual(splitMessage(source, 7));
		expect(chunks.join("")).toBe(source);
	});

	it("falls back when model chunks rewrite or omit source content", async () => {
		const source = "abc def\nghijk";
		const chunks = await smartSplitMessage(
			runtimeReturning(JSON.stringify(["abc de", "ghijk"])),
			source,
			7,
		);
		expect(chunks).toEqual(splitMessage(source, 7));
		expect(chunks.join("")).toBe(source);
	});

	it("falls back instead of dropping an oversized model chunk", async () => {
		const source = "abcdefghijk";
		const chunks = await smartSplitMessage(
			runtimeReturning(JSON.stringify(["abcdefgh", "ijk"])),
			source,
			6,
		);
		expect(chunks).toEqual(splitMessage(source, 6));
		expect(chunks.join("")).toBe(source);
	});

	it("preserves repeated whitespace, newlines, and Unicode exactly", async () => {
		const source = "alpha  beta\n\n🎉 gamma   delta";
		const chunks = await smartSplitMessage(
			runtimeReturning(JSON.stringify(["alpha beta", "🎉 gamma delta"])),
			source,
			9,
		);
		expect(chunks.join("")).toBe(source);
		expect(chunks.every((chunk) => chunk.length <= 9)).toBe(true);
	});
});

describe("sendMessageInChunks content preservation", () => {
	it("sends boundary whitespace without trimming it", async () => {
		const send = vi.fn(async () => ({ id: "sent" }));
		const channel = { send } as unknown as Parameters<
			typeof sendMessageInChunks
		>[0];
		const content = "  leading and trailing  ";

		await sendMessageInChunks(channel, content, "", []);

		expect(send).toHaveBeenCalledWith(expect.objectContaining({ content }));
	});
});
