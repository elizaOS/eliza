import { describe, expect, it } from "vitest";
import { stampAppConversationProvenance } from "../src/memory";
import type { Memory } from "../src/types/memory";
import type { UUID } from "../src/types/primitives";

const AGENT_ID = "33333333-3333-4333-8333-333333333333" as UUID;
const ROOM_ID = "22222222-2222-4222-8222-222222222222" as UUID;

function messageMemory(): Memory {
	return {
		id: "11111111-1111-4111-8111-111111111111" as UUID,
		roomId: ROOM_ID,
		content: { text: "hello" },
		metadata: { type: "message", timestamp: 1 },
	} as Memory;
}

describe("stampAppConversationProvenance", () => {
	it("stamps a message memory as before", () => {
		const stamped = stampAppConversationProvenance(AGENT_ID, messageMemory());

		expect(stamped.metadata?.type).toBe("message");
		expect(stamped.agentId).toBe(AGENT_ID);
	});

	it("stamps a memory with no type as a message", () => {
		const memory = messageMemory();
		memory.metadata = { timestamp: 1 } as never;
		const stamped = stampAppConversationProvenance(AGENT_ID, memory);

		expect(stamped.metadata?.type).toBe("message");
	});

	it("refuses to retype a document memory as a message", () => {
		const memory = messageMemory();
		memory.metadata = { type: "document", timestamp: 1 } as never;

		expect(() => stampAppConversationProvenance(AGENT_ID, memory)).toThrow(
			/not a message memory/,
		);
		// The record must be untouched by the failed stamp.
		expect(memory.metadata?.type).toBe("document");
		expect(memory.agentId).toBeUndefined();
	});

	it("refuses to retype a fragment memory as a message", () => {
		const memory = messageMemory();
		memory.metadata = { type: "fragment", timestamp: 1 } as never;

		expect(() => stampAppConversationProvenance(AGENT_ID, memory)).toThrow(
			/Conversation memory is not a message memory/,
		);
	});
});
