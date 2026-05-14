import { describe, expect, test, vi } from "vitest";
import {
	SECRET_BALLOTS_CLIENT_SERVICE,
	type SecretBallotEnvelope,
	type SecretBallotsClient,
	type SecretBallotTallyResult,
} from "../types";
import { tallyBallotIfThresholdMetAction } from "./tally-ballot-if-threshold-met";

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

describe("TALLY_BALLOT_IF_THRESHOLD_MET", () => {
	test("reports tallied=true when threshold is met", async () => {
		const tallyResult: SecretBallotTallyResult = {
			threshold: 2,
			totalVotes: 2,
			values: ["yes", "yes"],
			counts: { yes: 2 },
			tallySchemaVersion: 1,
			tallyMethod: "plaintext_v1",
		};
		const tallyIfThresholdMet = vi.fn().mockResolvedValue({
			tallied: true,
			ballot: envelope({ status: "tallied", tallyResult }),
			result: tallyResult,
		});
		const client = makeClient({ tallyIfThresholdMet });

		const result = await tallyBallotIfThresholdMetAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{ parameters: { ballotId: "ballot_1" } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.data?.tallied).toBe(true);
		const ballot = result.data?.ballot as SecretBallotEnvelope;
		expect(ballot.status).toBe("tallied");
		expect(ballot.tallyResult?.counts).toEqual({ yes: 2 });
	});

	test("reports tallied=false when threshold is not yet met", async () => {
		const tallyIfThresholdMet = vi.fn().mockResolvedValue({
			tallied: false,
			ballot: envelope(),
			result: null,
		});
		const client = makeClient({ tallyIfThresholdMet });

		const result = await tallyBallotIfThresholdMetAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{ parameters: { ballotId: "ballot_1" } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.data?.tallied).toBe(false);
	});

	test("does NOT include the tally values in the action text", async () => {
		const tallyIfThresholdMet = vi.fn().mockResolvedValue({
			tallied: true,
			ballot: envelope({
				status: "tallied",
				tallyResult: {
					threshold: 2,
					totalVotes: 2,
					values: ["secret-a", "secret-b"],
					counts: { "secret-a": 1, "secret-b": 1 },
					tallySchemaVersion: 1,
					tallyMethod: "plaintext_v1",
				},
			}),
			result: null,
		});
		const client = makeClient({ tallyIfThresholdMet });

		const result = await tallyBallotIfThresholdMetAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{ parameters: { ballotId: "ballot_1" } } as never,
		);

		expect(result.text).not.toContain("secret-a");
		expect(result.text).not.toContain("secret-b");
	});
});
