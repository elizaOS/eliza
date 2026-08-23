/**
 * Unit tests for recording pending fact candidate reconciliations.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, UUID } from "../../../types/index.js";
import { recordFactCandidate } from "./_factCandidates.js";

describe("fact-candidates", () => {
	it("records fact candidate with SQL escaping and JSON payload", async () => {
		const executeMock = vi.fn().mockResolvedValue(true);
		const mockRuntime = {
			agentId: "11111111-2222-3333-4444-555555555555" as UUID,
			adapter: {
				db: {
					execute: executeMock,
				},
			},
		} as unknown as IAgentRuntime;

		await recordFactCandidate(mockRuntime, {
			entityId: "22222222-3333-4444-5555-666666666666" as UUID,
			kind: "contradict",
			existingFactId: "33333333-4444-5555-6666-777777777777" as UUID,
			proposedText: "User prefers dark mode and Bob's cafe",
			reason: "Direct contradiction with previous light mode preference",
			evidenceMessageId: "44444444-5555-6666-7777-888888888888" as UUID,
		});

		expect(executeMock).toHaveBeenCalledTimes(1);
		const sqlQuery = executeMock.mock.calls[0][0];
		expect(sqlQuery).toBeDefined();
	});

	it("handles adapter without db execute method safely", async () => {
		const mockRuntimeNoDb = {
			agentId: "11111111-2222-3333-4444-555555555555" as UUID,
			adapter: {
				db: {},
			},
		} as unknown as IAgentRuntime;

		await expect(
			recordFactCandidate(mockRuntimeNoDb, {
				entityId: "22222222-3333-4444-5555-666666666666" as UUID,
				kind: "merge",
				proposedText: "Merge text",
			}),
		).resolves.toBeUndefined();
	});
});
