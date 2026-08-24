/**
 * Unit tests for character gate notice provider.
 * Validates detection of persistent personality modifications, disengagement bypassing,
 * and role-gated refusal notices.
 */
import { describe, expect, it, vi } from "vitest";
import { characterGateNoticeProvider } from "../features/advanced-capabilities/personality/providers/character-gate-notice.ts";
import type { Action, IAgentRuntime, Memory } from "../types/index.ts";

describe("character-gate-notice provider", () => {
	it("returns empty result for ordinary non-configuration messages", async () => {
		const runtime = {
			agentId: "agent-0000-0000-0000-000000000000",
			character: { name: "Eliza" },
			actions: [],
		} as unknown as IAgentRuntime;

		const message = {
			content: { text: "What is the capital of France?" },
		} as unknown as Memory;

		const result = await characterGateNoticeProvider.get(runtime, message);
		expect(result.text).toBe("");
		expect(result.values?.characterModificationGated).toBeUndefined();
	});

	it("returns empty result for disengagement directives", async () => {
		const runtime = {
			agentId: "agent-0000-0000-0000-000000000000",
			character: { name: "Eliza" },
			actions: [],
		} as unknown as IAgentRuntime;

		const message = {
			content: { text: "please stop replying to me" },
		} as unknown as Memory;

		const result = await characterGateNoticeProvider.get(runtime, message);
		expect(result.text).toBe("");
	});

	it("returns gate notice when unauthorized user attempts persistent personality modification", async () => {
		const characterAction: Action = {
			name: "CHARACTER",
			description: "Modify character",
			roleGate: { minRole: "OWNER" },
			handler: async () => ({ success: true }),
			validate: async () => true,
		};

		const runtime = {
			agentId: "agent-0000-0000-0000-000000000000",
			character: { name: "Eliza" },
			actions: [characterAction],
			getService: vi.fn().mockReturnValue(null),
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;

		const message = {
			userId: "user-123",
			entityId: "entity-123",
			content: { text: "change your personality to sarcastic permanently" },
		} as unknown as Memory;

		const result = await characterGateNoticeProvider.get(runtime, message);
		expect(result.values?.characterModificationGated).toBe(true);
		expect(result.values?.requiredRole).toBe("OWNER");
		expect(result.text).toContain("# Character modification access notice");
		expect(result.text).toContain("requires the OWNER role");
	});
});
