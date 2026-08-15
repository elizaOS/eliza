/**
 * Pins the candidate-rejection log contract (#20001): when an EXPLICIT
 * stage-1 candidate is dropped at exposure, the structured warn with the
 * preserved gate reason is the deliverable — an unpinned log dies silently in
 * the next refactor. Live motivation: the poisoned owner-exclusive disclosure
 * census (#19999) killed every owner-life candidate in a DM with zero log
 * lines across four trajectories.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../logger";
import type { Action, IAgentRuntime, Memory, State } from "../../types";
import { collectV5PlannerCandidateActions } from "../message";

const message = {
	id: "00000000-0000-0000-0000-000000000001",
	entityId: "00000000-0000-0000-0000-000000000002",
	roomId: "00000000-0000-0000-0000-000000000003",
	content: { text: "list my reminders" },
} as unknown as Memory;

function runtimeWith(actions: Action[]): IAgentRuntime {
	return {
		actions,
		agentId: "00000000-0000-0000-0000-000000000009",
		reportError: vi.fn(),
		getSetting: () => undefined,
		getService: () => null,
	} as unknown as IAgentRuntime;
}

describe("explicit candidate rejection observability", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("warns with the preserved gate reason when an explicit candidate is gate-rejected", async () => {
		const gated: Action = {
			name: "OWNER_REMINDERS",
			description: "owner reminders",
			// Role gate the anonymous test caller cannot satisfy — rejection
			// flows through actionGateFailure with a reason string.
			roleGate: { minRole: "OWNER" },
			validate: async () => true,
			handler: async () => ({ success: true }),
		} as unknown as Action;

		const selected = await collectV5PlannerCandidateActions({
			runtime: runtimeWith([gated]),
			message,
			state: {} as State,
			candidateActions: ["OWNER_REMINDERS"],
			userRoles: [],
		});

		expect(selected.map((a) => a.name)).not.toContain("OWNER_REMINDERS");
		const call = warnSpy.mock.calls.find(
			([fields]) =>
				(fields as { candidate?: string }).candidate === "OWNER_REMINDERS",
		);
		expect(call).toBeDefined();
		expect((call?.[0] as { gate?: string }).gate).toMatch(/not allowed/);
	});

	it("warns when an explicit candidate resolves to no runtime action", async () => {
		const selected = await collectV5PlannerCandidateActions({
			runtime: runtimeWith([]),
			message,
			state: {} as State,
			candidateActions: ["TOTALLY_UNKNOWN_ACTION"],
			userRoles: [],
		});

		expect(selected).toHaveLength(0);
		const call = warnSpy.mock.calls.find(
			([fields]) =>
				(fields as { candidate?: string }).candidate ===
				"TOTALLY_UNKNOWN_ACTION",
		);
		expect(call).toBeDefined();
		expect((call?.[0] as { gate?: string }).gate).toBe(
			"resolved-to-no-runtime-action",
		);
	});
});
