import { describe, expect, test, vi } from "vitest";
import {
	SECRET_BALLOTS_CLIENT_SERVICE,
	type SecretBallotsClient,
} from "../types";
import { submitBallotVoteAction } from "./submit-ballot-vote";

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

function makeClient(
	overrides: Partial<SecretBallotsClient> = {},
): SecretBallotsClient {
	return {
		create: vi.fn(),
		get: vi.fn(),
		distribute: vi.fn(),
		submitVote: vi.fn(),
		tallyIfThresholdMet: vi.fn(),
		expireBallot: vi.fn(),
		...overrides,
	};
}

describe("SUBMIT_BALLOT_VOTE", () => {
	test("returns success when the client records the vote", async () => {
		const submitVote = vi.fn().mockResolvedValue({
			ok: true,
			outcome: "recorded",
			ballotStatus: "open",
		});
		const client = makeClient({ submitVote });

		const result = await submitBallotVoteAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					ballotId: "ballot_1",
					scopedToken: "sb_xyz",
					value: "yes",
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(submitVote).toHaveBeenCalledWith({
			ballotId: "ballot_1",
			scopedToken: "sb_xyz",
			value: "yes",
		});
		expect(result.data?.outcome).toBe("recorded");
	});

	test("returns idempotent success for replay_same_value", async () => {
		const submitVote = vi.fn().mockResolvedValue({
			ok: true,
			outcome: "replay_same_value",
			ballotStatus: "open",
		});
		const client = makeClient({ submitVote });

		const result = await submitBallotVoteAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: { ballotId: "ballot_1", scopedToken: "sb_x", value: "yes" },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(result.data?.outcome).toBe("replay_same_value");
	});

	test("returns failure when the client rejects on conflict", async () => {
		const submitVote = vi
			.fn()
			.mockResolvedValue({ ok: false, reason: "conflict_different_value" });
		const client = makeClient({ submitVote });

		const result = await submitBallotVoteAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: { ballotId: "ballot_1", scopedToken: "sb_x", value: "no" },
			} as never,
		);

		expect(result.success).toBe(false);
		expect(result.data?.reason).toBe("conflict_different_value");
	});
});
