/**
 * `requireConfirmation` must bind its decision to a LATER user message. The
 * planner can call the same action twice inside one turn with the same
 * message (e.g. the cloud native planner's iteration loop), so the message
 * that asked for the operation must never count as the yes that confirms it.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../src";
import { requireConfirmation } from "../src/utils/confirmation";

function createRuntime(): IAgentRuntime {
	const cache = new Map<string, unknown>();
	return {
		agentId: "00000000-0000-0000-0000-00000000agent",
		getCache: async (key: string) => cache.get(key),
		setCache: async (key: string, value: unknown) => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string) => cache.delete(key),
	} as unknown as IAgentRuntime;
}

let clock = 1_000;
function userMessage(id: string, text: string): Memory {
	clock += 1_000;
	return {
		id: id as UUID,
		entityId: "00000000-0000-0000-0000-00000000user" as UUID,
		roomId: "00000000-0000-0000-0000-00000000room" as UUID,
		content: { text },
		createdAt: clock,
	} as Memory;
}

const gate = (runtime: IAgentRuntime, message: Memory) =>
	requireConfirmation({
		runtime,
		message,
		actionName: "WALLET_TRANSFER",
		pendingKey: "transfer:1eth",
		prompt: "Send 1 ETH to 0xabc? Reply yes to confirm.",
	});

describe("requireConfirmation reply binding", () => {
	it("does not let the requesting message confirm its own request", async () => {
		const runtime = createRuntime();
		const request = userMessage("msg-1", "Yes, send 1 ETH to 0xabc now");
		expect((await gate(runtime, request)).status).toBe("pending");
		// Same turn, same message: the planner re-invokes the action.
		expect((await gate(runtime, request)).status).toBe("pending");
		// The owner's real reply on the next turn confirms.
		const reply = userMessage("msg-2", "yes");
		reply.createdAt = Date.now() + 1;
		expect((await gate(runtime, reply)).status).toBe("confirmed");
	});

	it("ignores a message older than the prompt even with a new id", async () => {
		const runtime = createRuntime();
		const request = userMessage("old-1", "ok, delete the contact");
		expect((await gate(runtime, request)).status).toBe("pending");
		const replayed = { ...request, id: "old-2" as UUID };
		expect((await gate(runtime, replayed)).status).toBe("pending");
	});

	it("still confirms and cancels on a later reply", async () => {
		const runtime = createRuntime();
		expect((await gate(runtime, userMessage("a", "send 1 ETH"))).status).toBe(
			"pending",
		);
		const no = userMessage("b", "no");
		no.createdAt = Date.now() + 1;
		expect((await gate(runtime, no)).status).toBe("cancelled");
		expect((await gate(runtime, userMessage("c", "send 1 ETH"))).status).toBe(
			"pending",
		);
		const ok = userMessage("d", "ok");
		ok.createdAt = Date.now() + 1;
		expect((await gate(runtime, ok)).status).toBe("confirmed");
	});
});
