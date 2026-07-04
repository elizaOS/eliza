/**
 * Unit tests for the automated-turn classifiers: connector-stamped `fromBot`
 * (both metadata locations), internal bridge sources, sub-agent metadata, and
 * the human default when no structural signal is present.
 */
import { describe, expect, it } from "vitest";
import type { Memory, UUID } from "../types/index.ts";
import {
	isAutomatedSenderTurn,
	isBotAuthoredMessage,
	isInternalBridgeMessage,
} from "./automated-turns.ts";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		content: { text: "hello" },
		...overrides,
	} as Memory;
}

describe("automated-turn classifiers", () => {
	it("treats unstamped messages as human", () => {
		const memory = makeMemory({ content: { text: "gm", source: "discord" } });
		expect(isBotAuthoredMessage(memory)).toBe(false);
		expect(isInternalBridgeMessage(memory)).toBe(false);
		expect(isAutomatedSenderTurn(memory)).toBe(false);
	});

	it("detects connector-stamped fromBot in content metadata", () => {
		const memory = makeMemory({
			content: {
				text: "relayed",
				source: "discord",
				metadata: { fromBot: true },
			},
		});
		expect(isBotAuthoredMessage(memory)).toBe(true);
		expect(isAutomatedSenderTurn(memory)).toBe(true);
	});

	it("detects connector-stamped fromBot in top-level metadata", () => {
		const memory = makeMemory({
			metadata: { fromBot: true } as Memory["metadata"],
		});
		expect(isBotAuthoredMessage(memory)).toBe(true);
		expect(isAutomatedSenderTurn(memory)).toBe(true);
	});

	it("detects internal bridge sources", () => {
		for (const source of ["acpx:sub-agent-router", "swarm_synthesis"]) {
			const memory = makeMemory({ content: { text: "x", source } });
			expect(isInternalBridgeMessage(memory)).toBe(true);
			expect(isAutomatedSenderTurn(memory)).toBe(true);
		}
	});

	it("detects sub-agent rows via content metadata", () => {
		const memory = makeMemory({
			content: { text: "done", metadata: { subAgent: true } },
		});
		expect(isInternalBridgeMessage(memory)).toBe(true);
	});

	it("does not treat a truthy non-boolean stamp as automation", () => {
		const memory = makeMemory({
			content: { text: "gm", metadata: { fromBot: "yes" } },
		});
		expect(isBotAuthoredMessage(memory)).toBe(false);
	});
});
