/**
 * Unit tests for pending user action contracts and attention weights.
 * Validates weights per action kind, option structures, and resolution targets.
 */
import { describe, expect, it } from "vitest";
import {
	PENDING_USER_ACTION_WEIGHT,
	type PendingUserAction,
	type PendingUserActionKind,
	type PendingUserActionOption,
	type PendingUserActionResolution,
} from "../types/pending-user-action.ts";

describe("pending-user-action", () => {
	describe("PENDING_USER_ACTION_WEIGHT", () => {
		it("defines expected canonical attention weights for all action kinds", () => {
			expect(PENDING_USER_ACTION_WEIGHT.approval).toBe(9);
			expect(PENDING_USER_ACTION_WEIGHT.task_approval).toBe(9);
			expect(PENDING_USER_ACTION_WEIGHT.choice).toBe(9);
			expect(PENDING_USER_ACTION_WEIGHT.credential).toBe(8);
			expect(PENDING_USER_ACTION_WEIGHT.credential_request).toBe(8);
			expect(PENDING_USER_ACTION_WEIGHT.clarifying_question).toBe(7);
			expect(PENDING_USER_ACTION_WEIGHT.blocked_task).toBe(10);
			expect(PENDING_USER_ACTION_WEIGHT.prompt).toBe(6);
			expect(PENDING_USER_ACTION_WEIGHT.pending_prompt).toBe(6);
		});

		it("ensures all weights are positive integers", () => {
			const kinds: PendingUserActionKind[] = [
				"approval",
				"task_approval",
				"choice",
				"credential",
				"credential_request",
				"clarifying_question",
				"blocked_task",
				"prompt",
				"pending_prompt",
			];

			for (const kind of kinds) {
				const weight = PENDING_USER_ACTION_WEIGHT[kind];
				expect(typeof weight).toBe("number");
				expect(weight).toBeGreaterThan(0);
				expect(Number.isInteger(weight)).toBe(true);
			}
		});

		it("prioritizes blocked tasks with the highest weight", () => {
			const maxWeight = Math.max(...Object.values(PENDING_USER_ACTION_WEIGHT));
			expect(PENDING_USER_ACTION_WEIGHT.blocked_task).toBe(maxWeight);
		});
	});

	describe("PendingUserAction shape", () => {
		it("instantiates a structured action with options and resolution", () => {
			const option: PendingUserActionOption = {
				id: "opt-approve",
				label: "Approve Mutation",
				isDefault: true,
				isCancel: false,
			};

			const resolution: PendingUserActionResolution = {
				target: "approval_service",
				requestId: "req-999",
				action: "APPROVE_TRANSACTION",
			};

			const action: PendingUserAction = {
				id: "action-123",
				kind: "approval",
				source: "ApprovalService",
				title: "Transfer Approval Required",
				description: "Authorize transaction of 10 USDC",
				options: [option],
				resolution,
				weight: PENDING_USER_ACTION_WEIGHT.approval,
				createdAt: 1700000000000,
				expiresAt: 1700000060000,
			};

			expect(action.id).toBe("action-123");
			expect(action.kind).toBe("approval");
			expect(action.options).toHaveLength(1);
			expect(action.options?.[0].id).toBe("opt-approve");
			expect(action.resolution?.target).toBe("approval_service");
		});
	});
});
