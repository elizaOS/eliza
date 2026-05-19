import { describe, expect, test, vi } from "vitest";
import {
	SECRET_BALLOTS_CLIENT_SERVICE,
	type SecretBallotEnvelope,
	type SecretBallotsClient,
} from "../types";
import { expireBallotAction } from "./expire-ballot";

function envelope(
	overrides: Partial<SecretBallotEnvelope> = {},
): SecretBallotEnvelope {
	return {
		ballotId: "ballot_1",
		organizationId: "org-1",
		agentId: null,
		purpose: "test",
		participants: [{ identityId: "u1" }],
		threshold: 1,
		status: "expired",
		tallyResult: null,
		expiresAt: Date.now() - 1000,
		createdAt: Date.now() - 60_000,
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

describe("EXPIRE_BALLOT", () => {
	test("expires the ballot via the client", async () => {
		const expireBallot = vi
			.fn()
			.mockResolvedValue(envelope({ status: "expired" }));
		const client = makeClient({ expireBallot });

		const result = await expireBallotAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{ parameters: { ballotId: "ballot_1" } } as never,
		);

		expect(result.success).toBe(true);
		expect(expireBallot).toHaveBeenCalledWith({ ballotId: "ballot_1" });
		expect(result.data?.status).toBe("expired");
	});

	test("returns failure when the ballot ends up non-expired", async () => {
		const expireBallot = vi
			.fn()
			.mockResolvedValue(envelope({ status: "tallied" }));
		const client = makeClient({ expireBallot });

		const result = await expireBallotAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{ parameters: { ballotId: "ballot_1" } } as never,
		);

		expect(result.success).toBe(false);
		expect(result.data?.status).toBe("tallied");
	});

	test("rejects missing ballotId", async () => {
		const client = makeClient();
		const result = await expireBallotAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{ parameters: {} } as never,
		);
		expect(result.success).toBe(false);
		expect(client.expireBallot).not.toHaveBeenCalled();
	});
});
