/**
 * Ordering contract for the bot-noise triage history block.
 *
 * Exercises the shipped `compareMemoryByCreatedAt` and the real
 * `runBotNoiseTriage` path against a deterministic fake runtime: the history
 * rendered into the TEXT_SMALL prompt must stay oldest-first, and a corrupted
 * non-finite `createdAt` must not make the comparator return `NaN` and leave
 * the surrounding pairs in an engine-defined order.
 */

import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../../types/memory";
import { ChannelType, type UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import {
	compareMemoryByCreatedAt,
	runBotNoiseTriage,
} from "./bot-noise-triage";

const AGENT_ID = "00000000-0000-0000-0000-00000000000a" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000000b" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-00000000000c" as UUID;

function botMessage(id: string, createdAt: number, text: string): Memory {
	return {
		id: id as UUID,
		entityId: SENDER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text, source: "discord", channelType: ChannelType.GROUP },
		metadata: {
			type: "message",
			fromBot: true,
			entityName: "ZenithProxy",
		} as Memory["metadata"],
		createdAt,
	};
}

function makeRuntime(
	memories: Memory[],
): IAgentRuntime & { useModel: ReturnType<typeof vi.fn> } {
	return {
		agentId: AGENT_ID,
		character: { name: "Remilio" },
		getSetting: () => undefined,
		useModel: vi.fn(async () => "IGNORE"),
		getMemories: vi.fn(async () => memories),
		reportError: vi.fn(),
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
	} as unknown as IAgentRuntime & { useModel: ReturnType<typeof vi.fn> };
}

async function promptFor(memories: Memory[], current: Memory): Promise<string> {
	const runtime = makeRuntime(memories);
	await runBotNoiseTriage({
		runtime,
		message: current,
		explicitlyAddressesAgent: false,
	});
	const [, params] = runtime.useModel.mock.calls[0] as [
		string,
		{ prompt: string },
	];
	return params.prompt;
}

describe("compareMemoryByCreatedAt", () => {
	it("orders finite timestamps ascending (oldest first)", () => {
		const a = botMessage("00000000-0000-0000-0000-000000000031", 1, "a");
		const b = botMessage("00000000-0000-0000-0000-000000000032", 2, "b");
		expect(compareMemoryByCreatedAt(a, b)).toBeLessThan(0);
		expect(compareMemoryByCreatedAt(b, a)).toBeGreaterThan(0);
	});

	it("never returns NaN when a timestamp is non-finite", () => {
		const broken = botMessage(
			"00000000-0000-0000-0000-000000000033",
			Number.NaN,
			"broken",
		);
		const good = botMessage("00000000-0000-0000-0000-000000000034", 5, "good");
		expect(Number.isNaN(compareMemoryByCreatedAt(broken, good))).toBe(false);
		expect(Number.isNaN(compareMemoryByCreatedAt(good, broken))).toBe(false);
		// NaN is normalised to 0, so it sorts before a positive timestamp.
		expect(compareMemoryByCreatedAt(broken, good)).toBeLessThan(0);
	});

	it("breaks timestamp ties deterministically by id", () => {
		const z = botMessage("00000000-0000-0000-0000-0000000000bb", 5, "z");
		const a = botMessage("00000000-0000-0000-0000-0000000000ab", 5, "a");
		expect(compareMemoryByCreatedAt(a, z)).toBeLessThan(0);
		expect(compareMemoryByCreatedAt(z, a)).toBeGreaterThan(0);
	});
});

describe("runBotNoiseTriage history ordering", () => {
	it("renders history oldest-first in the model prompt", async () => {
		const first = botMessage(
			"00000000-0000-0000-0000-000000000041",
			10,
			"first update",
		);
		const second = botMessage(
			"00000000-0000-0000-0000-000000000042",
			20,
			"second update",
		);
		const third = botMessage(
			"00000000-0000-0000-0000-000000000043",
			30,
			"third update",
		);
		const current = botMessage(
			"00000000-0000-0000-0000-000000000044",
			40,
			"newest embed",
		);
		const prompt = await promptFor([third, first, second, current], current);
		const idx = [
			prompt.indexOf("first update"),
			prompt.indexOf("second update"),
			prompt.indexOf("third update"),
		];
		expect(idx.every((i) => i > -1)).toBe(true);
		expect(idx[0]).toBeLessThan(idx[1]);
		expect(idx[1]).toBeLessThan(idx[2]);
	});

	it("keeps the finite entries in chronological order around a NaN timestamp", async () => {
		const broken = botMessage(
			"00000000-0000-0000-0000-000000000051",
			Number.NaN,
			"corrupted row",
		);
		const early = botMessage(
			"00000000-0000-0000-0000-000000000052",
			100,
			"early update",
		);
		const late = botMessage(
			"00000000-0000-0000-0000-000000000053",
			200,
			"late update",
		);
		const current = botMessage(
			"00000000-0000-0000-0000-000000000054",
			300,
			"newest embed",
		);
		// The NaN row is deliberately interleaved between two out-of-order finite
		// rows: a NaN-returning comparator reads that pair as "equal", leaves the
		// run in place, and renders the conversation backwards in the prompt.
		const prompt = await promptFor([late, broken, early, current], current);
		const brokenIdx = prompt.indexOf("corrupted row");
		const earlyIdx = prompt.indexOf("early update");
		const lateIdx = prompt.indexOf("late update");
		expect(brokenIdx).toBeGreaterThan(-1);
		expect(earlyIdx).toBeGreaterThan(brokenIdx);
		expect(lateIdx).toBeGreaterThan(earlyIdx);
	});
});
