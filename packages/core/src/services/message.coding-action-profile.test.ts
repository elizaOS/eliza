/** Verifies coding action profiles fail closed before the message lifecycle has side effects. */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, MessageProcessingOptions } from "../types";
import { DefaultMessageService } from "./message";

function inertMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		agentId: "00000000-0000-0000-0000-000000000002",
		entityId: "00000000-0000-0000-0000-000000000003",
		roomId: "00000000-0000-0000-0000-000000000004",
		content: { text: "work" },
	} as Memory;
}

function untouchedRuntime(): IAgentRuntime {
	return new Proxy({} as IAgentRuntime, {
		get(_target, property) {
			throw new Error(`runtime side effect: ${String(property)}`);
		},
	});
}

describe("DefaultMessageService coding action profile boundary", () => {
	it.each([
		{
			label: "invalid shape",
			options: {
				codingMode: true,
				codingActionProfile: { kind: "pi", includeWorktree: "yes" },
			} as unknown as MessageProcessingOptions,
			code: "INVALID_CODING_ACTION_PROFILE",
		},
		{
			label: "profile without coding mode",
			options: { codingActionProfile: { kind: "pi" } },
			code: "CODING_ACTION_PROFILE_REQUIRES_CODING_MODE",
		},
	])(
		"rejects $label before events, actions, or callbacks",
		async ({ options, code }) => {
			const message = inertMessage();
			const callback = vi.fn();

			await expect(
				new DefaultMessageService().handleMessage(
					untouchedRuntime(),
					message,
					callback,
					options,
				),
			).rejects.toMatchObject({ code });
			expect(callback).not.toHaveBeenCalled();
			expect(message.metadata).toBeUndefined();
		},
	);
});
