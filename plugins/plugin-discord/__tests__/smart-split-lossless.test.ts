/**
 * Verifies model-assisted Discord splitting is accepted only when every
 * source code unit remains recoverable in order.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { smartSplitMessage, splitMessage } from "../utils";

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

	it("accepts a projection that only reflows boundary whitespace", async () => {
		const source = "abc def\nghijk";
		const chunks = await smartSplitMessage(
			runtimeReturning(JSON.stringify(["abc def", "ghijk"])),
			source,
			7,
		);
		expect(chunks).toEqual(["abc def", "ghijk"]);
	});

	it("falls back when model chunks rewrite or omit source content", async () => {
		const source = "abc def\nghijk";
		const chunks = await smartSplitMessage(
			runtimeReturning(JSON.stringify(["abc de", "ghijk"])),
			source,
			7,
		);
		expect(chunks).toEqual(splitMessage(source, 7));
		expect(chunks.join("").replace(/\s+/g, "")).toBe(
			source.replace(/\s+/g, ""),
		);
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
});
