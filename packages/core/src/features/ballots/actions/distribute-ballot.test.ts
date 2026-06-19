import { describe, expect, test, vi } from "vitest";
import {
	SECRET_BALLOTS_CLIENT_SERVICE,
	type SecretBallotsClient,
} from "../types";
import { distributeBallotAction } from "./distribute-ballot";

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

describe("DISTRIBUTE_BALLOT", () => {
	test("dispatches via the client when target=dm", async () => {
		const distribute = vi
			.fn()
			.mockResolvedValue({ ballotId: "ballot_1", target: "dm", dispatched: 2 });
		const client = makeClient({ distribute });

		const result = await distributeBallotAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: { ballotId: "ballot_1", target: "dm" },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(distribute).toHaveBeenCalledWith({
			ballotId: "ballot_1",
			target: "dm",
		});
		expect(result.data?.dispatched).toBe(2);
	});

	test("rejects non-DM target without calling the client", async () => {
		const distribute = vi.fn();
		const client = makeClient({ distribute });

		const result = await distributeBallotAction.handler(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: { ballotId: "ballot_1", target: "public_link" },
			} as never,
		);

		expect(result.success).toBe(false);
		expect(distribute).not.toHaveBeenCalled();
		expect(result.data?.reason).toBe("non_dm_target_forbidden");
		expect(result.data?.rejectedTarget).toBe("public_link");
	});

	test("validate rejects non-DM target", async () => {
		const client = makeClient();
		const ok = await distributeBallotAction.validate?.(
			createRuntime({ [SECRET_BALLOTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: { ballotId: "ballot_1", target: "public_link" },
			} as never,
		);
		expect(ok).toBe(false);
	});
});
