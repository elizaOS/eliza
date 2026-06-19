import { describe, expect, test, vi } from "vitest";
import {
	SECRET_BALLOTS_CLIENT_SERVICE,
	type SecretBallotEnvelope,
	type SecretBallotsClient,
} from "../types";
import { createSecretBallotAction } from "./create-secret-ballot";

function envelope(
	overrides: Partial<SecretBallotEnvelope> = {},
): SecretBallotEnvelope {
	return {
		ballotId: "ballot_1",
		organizationId: "org-1",
		agentId: null,
		purpose: "test",
		participants: [{ identityId: "u1" }, { identityId: "u2" }],
		threshold: 2,
		status: "open",
		tallyResult: null,
		expiresAt: Date.now() + 60_000,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("CREATE_SECRET_BALLOT", () => {
	test("creates ballot and returns ballotId + expiresAt (no tokens)", async () => {
		const create = vi.fn().mockResolvedValue(envelope());
		const client: SecretBallotsClient = {
			create,
			get: vi.fn(),
			distribute: vi.fn(),
			submitVote: vi.fn(),
			tallyIfThresholdMet: vi.fn(),
			expireBallot: vi.fn(),
		};
		const callback = vi.fn();

		const result = await createSecretBallotAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					purpose: "Pick a winner",
					participants: [{ identityId: "u1" }, { identityId: "u2" }],
					threshold: 2,
				},
			} as never,
			callback,
		);

		expect(result.success).toBe(true);
		expect(result.data?.actionName).toBe("CREATE_SECRET_BALLOT");
		expect(result.data?.ballotId).toBe("ballot_1");
		expect(result.data?.expiresAt).toEqual(expect.any(Number));
		expect(result.data).not.toHaveProperty("participantTokens");
		expect(create).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalled();
	});

	test("rejects threshold > participant count", async () => {
		const client: SecretBallotsClient = {
			create: vi.fn(),
			get: vi.fn(),
			distribute: vi.fn(),
			submitVote: vi.fn(),
			tallyIfThresholdMet: vi.fn(),
			expireBallot: vi.fn(),
		};

		const result = await createSecretBallotAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					purpose: "x",
					participants: [{ identityId: "u1" }],
					threshold: 3,
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(client.create).not.toHaveBeenCalled();
	});

	test("rejects duplicate participant identityId", async () => {
		const client: SecretBallotsClient = {
			create: vi.fn(),
			get: vi.fn(),
			distribute: vi.fn(),
			submitVote: vi.fn(),
			tallyIfThresholdMet: vi.fn(),
			expireBallot: vi.fn(),
		};

		const result = await createSecretBallotAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					purpose: "x",
					participants: [{ identityId: "u1" }, { identityId: "u1" }],
					threshold: 1,
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(client.create).not.toHaveBeenCalled();
	});

	test("validate fails when client service is missing", async () => {
		const ok = await createSecretBallotAction.validate?.(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					purpose: "x",
					participants: [{ identityId: "u1" }],
					threshold: 1,
				},
			} as never,
		);
		expect(ok).toBe(false);
	});
});
