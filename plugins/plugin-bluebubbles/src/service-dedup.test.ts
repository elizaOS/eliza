/**
 * Deterministic replay coverage for BlueBubbles inbound webhook handling. The
 * harness stops at the durable-memory boundary, so no BlueBubbles server,
 * Messages account, or outbound iMessage is used.
 */

import type { Character, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BlueBubblesService } from "./service";
import type { BlueBubblesMessage } from "./types";

function message(guid = "message-guid-1"): BlueBubblesMessage {
	return {
		guid,
		text: "hello",
		isFromMe: false,
		isSystemMessage: false,
	} as BlueBubblesMessage;
}

function runtime(getMemoryById: IAgentRuntime["getMemoryById"]): IAgentRuntime {
	return {
		agentId: "11111111-1111-4111-8111-111111111111",
		character: {
			name: "Eliza",
			settings: {},
		} as Character,
		getSetting(key: string) {
			if (key === "BLUEBUBBLES_SERVER_URL") return "http://127.0.0.1:1234";
			if (key === "BLUEBUBBLES_PASSWORD") return "test-only-password";
			return null;
		},
		getMemoryById,
	} as unknown as IAgentRuntime;
}

describe("BlueBubbles inbound replay suppression", () => {
	it("stops a stored provider message before another agent turn", async () => {
		const getMemoryById = vi.fn().mockResolvedValue({
			id: "existing-memory",
		} as Memory);
		const service = new BlueBubblesService(runtime(getMemoryById));

		await service.handleWebhook({ type: "new-message", data: message() });

		expect(getMemoryById).toHaveBeenCalledTimes(1);
	});

	it("holds a concurrent delivery of the same provider GUID in process", async () => {
		let releaseLookup: ((memory: Memory | null) => void) | undefined;
		const getMemoryById = vi.fn(
			() =>
				new Promise<Memory | null>((resolve) => {
					releaseLookup = resolve;
				}),
		);
		const service = new BlueBubblesService(runtime(getMemoryById));
		const first = service.handleWebhook({
			type: "new-message",
			data: message("concurrent-guid"),
		});

		await service.handleWebhook({
			type: "new-message",
			data: message("concurrent-guid"),
		});

		expect(getMemoryById).toHaveBeenCalledTimes(1);
		releaseLookup?.({ id: "existing-memory" } as Memory);
		await first;
	});
});
