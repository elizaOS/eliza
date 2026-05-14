import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const BALLOT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-05-14T00:00:00.000Z");
const FUTURE = new Date("2026-05-15T00:00:00.000Z");

interface CapturedCall {
	op: string;
	payload?: unknown;
	table?: string;
	where?: unknown;
	set?: unknown;
	limit?: number;
	returning?: boolean;
}

interface DbStub {
	calls: CapturedCall[];
	selectRows: unknown[];
	insertRows: unknown[];
	updateRows: unknown[];
}

function makeBallotRow(overrides: Record<string, unknown> = {}) {
	return {
		id: BALLOT_ID,
		organization_id: ORG_ID,
		agent_id: null,
		purpose: "Pick a winner",
		participants: [{ identityId: "u1" }, { identityId: "u2" }],
		threshold: 2,
		status: "open",
		tally_result: null,
		expires_at: FUTURE,
		created_at: NOW,
		updated_at: NOW,
		metadata: {},
		...overrides,
	};
}

function makeVoteRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "vote-1",
		ballot_id: BALLOT_ID,
		participant_token_hash: "hash-1",
		participant_identity_id: "u1",
		value_ciphertext: "eWVz", // base64 "yes"
		recorded_at: NOW,
		...overrides,
	};
}

function tableName(table: unknown): string {
	if (!table || typeof table !== "object") return "unknown";
	const sym = Object.getOwnPropertySymbols(table).find(
		(s) => s.description === "drizzle:Name",
	);
	if (sym) {
		const value = (table as Record<symbol, unknown>)[sym];
		if (typeof value === "string") return value;
	}
	return "unknown";
}

function installDbMock(stub: DbStub): void {
	const insertChain = (table: unknown) => ({
		values: (payload: unknown) => ({
			returning: () => {
				stub.calls.push({
					op: "insert",
					table: tableName(table),
					payload,
					returning: true,
				});
				return Promise.resolve(stub.insertRows);
			},
		}),
	});

	const buildSelectChain = () => {
		const captured: CapturedCall = { op: "select" };
		const chain = {
			from(table: unknown) {
				captured.table = tableName(table);
				return chain;
			},
			where(predicate: unknown) {
				captured.where = predicate;
				return chain;
			},
			limit(l: number) {
				captured.limit = l;
				stub.calls.push(captured);
				return Promise.resolve(stub.selectRows);
			},
			then(
				onFulfilled?: (rows: unknown) => unknown,
				onRejected?: (err: unknown) => unknown,
			) {
				stub.calls.push(captured);
				return Promise.resolve(stub.selectRows).then(onFulfilled, onRejected);
			},
		};
		return chain;
	};

	const updateChain = (table: unknown) => ({
		set(values: unknown) {
			const captured: CapturedCall = {
				op: "update",
				table: tableName(table),
				set: values,
			};
			return {
				where(predicate: unknown) {
					captured.where = predicate;
					return {
						returning() {
							captured.returning = true;
							stub.calls.push(captured);
							return Promise.resolve(stub.updateRows);
						},
					};
				},
			};
		},
	});

	const dbStub = {
		insert: (table: unknown) => insertChain(table),
		select: () => buildSelectChain(),
		update: (table: unknown) => updateChain(table),
	};

	mock.module("@/db/client", () => ({
		dbWrite: dbStub,
		dbRead: dbStub,
		db: dbStub,
	}));
}

async function loadRepository() {
	const mod = await import(
		new URL(
			`../../../packages/db/repositories/secret-ballots.ts?test=${Date.now()}-${Math.random()}`,
			import.meta.url,
		).href
	);
	return mod.secretBallotsRepository as {
		createBallot: (input: unknown) => Promise<unknown>;
		getBallot: (id: string) => Promise<unknown>;
		updateBallot: (id: string, patch: unknown) => Promise<unknown>;
		recordVote: (input: unknown) => Promise<unknown>;
		findVoteByIdentity: (
			ballotId: string,
			identityId: string,
		) => Promise<unknown>;
		listVotes: (ballotId: string) => Promise<unknown[]>;
		countVotes: (ballotId: string) => Promise<number>;
		recordEvent: (input: unknown) => Promise<unknown>;
		expirePastBallots: (now: Date) => Promise<string[]>;
	};
}

describe("secret ballots repository", () => {
	beforeEach(() => mock.restore());
	afterEach(() => mock.restore());

	test("createBallot inserts and returns the new row", async () => {
		const stub: DbStub = {
			calls: [],
			selectRows: [],
			insertRows: [makeBallotRow()],
			updateRows: [],
		};
		installDbMock(stub);
		const repo = await loadRepository();

		const result = await repo.createBallot({
			organizationId: ORG_ID,
			purpose: "Pick a winner",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
			expiresAt: FUTURE,
		});

		expect(result).toMatchObject({
			id: BALLOT_ID,
			organizationId: ORG_ID,
			threshold: 2,
		});
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]).toMatchObject({
			op: "insert",
			table: "secret_ballots",
			returning: true,
		});
		expect(stub.calls[0].payload).toMatchObject({
			organization_id: ORG_ID,
			threshold: 2,
			status: "open",
			expires_at: FUTURE,
		});
	});

	test("recordVote returns replay_same_value when an identical vote already exists", async () => {
		const existing = makeVoteRow({ value_ciphertext: "eWVz" });
		const stub: DbStub = {
			calls: [],
			// first select (findVoteByIdentity) returns the existing vote
			selectRows: [existing],
			insertRows: [],
			updateRows: [],
		};
		installDbMock(stub);
		const repo = await loadRepository();

		const outcome = (await repo.recordVote({
			ballotId: BALLOT_ID,
			participantTokenHash: "hash-1",
			participantIdentityId: "u1",
			valueCiphertext: "eWVz",
		})) as { outcome: string; vote?: unknown };

		expect(outcome.outcome).toBe("replay_same_value");
		// no insert
		expect(stub.calls.find((c) => c.op === "insert")).toBeUndefined();
	});

	test("recordVote returns conflict_different_value when an existing vote has a different value", async () => {
		const existing = makeVoteRow({ value_ciphertext: "bm8=" }); // "no"
		const stub: DbStub = {
			calls: [],
			selectRows: [existing],
			insertRows: [],
			updateRows: [],
		};
		installDbMock(stub);
		const repo = await loadRepository();

		const outcome = (await repo.recordVote({
			ballotId: BALLOT_ID,
			participantTokenHash: "hash-1",
			participantIdentityId: "u1",
			valueCiphertext: "eWVz",
		})) as { outcome: string };

		expect(outcome.outcome).toBe("conflict_different_value");
		expect(stub.calls.find((c) => c.op === "insert")).toBeUndefined();
	});

	test("recordVote inserts a new row when no prior vote exists", async () => {
		const stub: DbStub = {
			calls: [],
			selectRows: [], // findVoteByIdentity returns empty
			insertRows: [makeVoteRow()],
			updateRows: [],
		};
		installDbMock(stub);
		const repo = await loadRepository();

		const outcome = (await repo.recordVote({
			ballotId: BALLOT_ID,
			participantTokenHash: "hash-1",
			participantIdentityId: "u1",
			valueCiphertext: "eWVz",
		})) as { outcome: string };

		expect(outcome.outcome).toBe("recorded");
		const insertCall = stub.calls.find((c) => c.op === "insert");
		expect(insertCall?.table).toBe("secret_ballot_votes");
		expect(insertCall?.payload).toMatchObject({
			ballot_id: BALLOT_ID,
			participant_identity_id: "u1",
			value_ciphertext: "eWVz",
		});
	});

	test("expirePastBallots updates open rows past expiry and returns their ids", async () => {
		const stub: DbStub = {
			calls: [],
			selectRows: [],
			insertRows: [],
			updateRows: [{ id: BALLOT_ID }],
		};
		installDbMock(stub);
		const repo = await loadRepository();

		const expired = await repo.expirePastBallots(new Date());
		expect(expired).toEqual([BALLOT_ID]);
		const updateCall = stub.calls.find((c) => c.op === "update");
		expect(updateCall?.table).toBe("secret_ballots");
		expect(updateCall?.set).toMatchObject({ status: "expired" });
	});
});
