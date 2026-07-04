/**
 * Unit tests for the internal-bridge-row classifier: bridge sources,
 * sub-agent metadata, and the human default when no structural signal is
 * present.
 */
import { describe, expect, it } from "vitest";
import type { Memory, UUID } from "../types/index.ts";
import { isInternalBridgeMessage } from "./automated-turns.ts";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		content: { text: "hello" },
		...overrides,
	} as Memory;
}

describe("isInternalBridgeMessage", () => {
	it("treats unstamped messages as human", () => {
		const memory = makeMemory({ content: { text: "gm", source: "discord" } });
		expect(isInternalBridgeMessage(memory)).toBe(false);
	});

	it("detects internal bridge sources", () => {
		for (const source of ["acpx:sub-agent-router", "swarm_synthesis"]) {
			const memory = makeMemory({ content: { text: "x", source } });
			expect(isInternalBridgeMessage(memory)).toBe(true);
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
			content: { text: "gm", metadata: { subAgent: "yes" } },
		});
		expect(isInternalBridgeMessage(memory)).toBe(false);
	});
});
