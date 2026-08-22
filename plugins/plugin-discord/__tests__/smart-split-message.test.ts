/**
 * `smartSplitMessage` must not silently drop body text when the model returns
 * a mixed valid/over-limit array. The real function is driven; `useModel` is
 * the network seam.
 */
import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	MAX_MESSAGE_LENGTH,
	needsSmartSplit,
	smartSplitMessage,
	splitMessage,
} from "../utils";

function makeRuntime(
	modelReply: string,
): IAgentRuntime & { useModel: ReturnType<typeof vi.fn> } {
	const useModel = vi.fn(async (_type: ModelTypeName, _opts: unknown) => {
		return modelReply;
	});
	return {
		agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		useModel,
	} as unknown as IAgentRuntime & { useModel: ReturnType<typeof vi.fn> };
}

const LONG_A = "A".repeat(1000);
const LONG_B = "B".repeat(1000);
const SOURCE = `${LONG_A}\n${LONG_B}`;

describe("smartSplitMessage", () => {
	it("selects the long-unbreakable-line path for this source", () => {
		expect(SOURCE.length).toBeGreaterThan(MAX_MESSAGE_LENGTH);
		expect(needsSmartSplit(SOURCE)).toBe(true);
	});

	it("falls back to a complete splitMessage when one model chunk is over the cap", async () => {
		const overlong = `${LONG_B}${"C".repeat(MAX_MESSAGE_LENGTH)}`;
		const runtime = makeRuntime(JSON.stringify([LONG_A, overlong]));

		const chunks = await smartSplitMessage(runtime, SOURCE, MAX_MESSAGE_LENGTH);

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(chunks.join("")).toContain(LONG_A);
		expect(chunks.join("")).toContain(LONG_B);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
		}
		expect(chunks).toEqual(splitMessage(SOURCE, MAX_MESSAGE_LENGTH));
	});

	it("keeps a complete in-limit model split", async () => {
		const runtime = makeRuntime(JSON.stringify([LONG_A, LONG_B]));
		const chunks = await smartSplitMessage(runtime, SOURCE, MAX_MESSAGE_LENGTH);
		expect(chunks).toEqual([LONG_A, LONG_B]);
	});

	it("falls back when the model returns no usable array", async () => {
		const runtime = makeRuntime("not-json");
		const chunks = await smartSplitMessage(runtime, SOURCE, MAX_MESSAGE_LENGTH);
		expect(chunks).toEqual(splitMessage(SOURCE, MAX_MESSAGE_LENGTH));
	});

	it("does not change under-limit text", async () => {
		const runtime = makeRuntime("[]");
		const chunks = await smartSplitMessage(
			runtime,
			"hello",
			MAX_MESSAGE_LENGTH,
		);
		expect(chunks).toEqual(["hello"]);
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("keeps a three-chunk in-limit model split of an over-cap source", async () => {
		const a = "A".repeat(700);
		const b = "B".repeat(700);
		const c = "C".repeat(700);
		const source = `${a}\n${b}\n${c}`;
		expect(source.length).toBeGreaterThan(MAX_MESSAGE_LENGTH);
		const runtime = makeRuntime(JSON.stringify([a, b, c]));
		const chunks = await smartSplitMessage(runtime, source, MAX_MESSAGE_LENGTH);
		expect(chunks).toEqual([a, b, c]);
	});
});
