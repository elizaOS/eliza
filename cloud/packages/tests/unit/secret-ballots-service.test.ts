import { beforeEach, describe, expect, test } from "bun:test";
import type {
	RecordVoteInput,
	RecordVoteOutcome,
	SecretBallotEventRow,
	SecretBallotRow,
	SecretBallotVoteRow,
	SecretBallotsRepository,
} from "../../db/repositories/secret-ballots";
import type {
	SecretBallotEventName,
	SecretBallotStatus,
	SecretBallotTallyResult,
} from "../../db/schemas/secret-ballots";
import {
	type CreateSecretBallotInput,
	createSecretBallotsService,
	type SecretBallotsService,
} from "../../lib/services/secret-ballots";

const ORG_ID = "org-1";

interface RecordedEvent {
	ballotId: string;
	eventName: SecretBallotEventName;
	redactedPayload?: Record<string, unknown>;
}

function makeRow(overrides: Partial<SecretBallotRow> = {}): SecretBallotRow {
	return {
		id: "ballot-test-1",
		organizationId: ORG_ID,
		agentId: null,
		purpose: "Pick a winner",
		participants: [{ identityId: "u1" }, { identityId: "u2" }],
		threshold: 2,
		status: "open",
		tallyResult: null,
		expiresAt: new Date(Date.now() + 60_000),
		createdAt: new Date(),
		updatedAt: new Date(),
		metadata: {},
		...overrides,
	};
}

interface FakeRepoState {
	repo: SecretBallotsRepository;
	store: Map<string, SecretBallotRow>;
	votes: SecretBallotVoteRow[];
	events: RecordedEvent[];
}

function makeFakeRepository(seed?: SecretBallotRow): FakeRepoState {
	const store = new Map<string, SecretBallotRow>();
	const votes: SecretBallotVoteRow[] = [];
	const events: RecordedEvent[] = [];
	if (seed) store.set(seed.id, seed);
	let ballotCounter = 0;
	let voteCounter = 0;
	let eventCounter = 0;

	const repo: SecretBallotsRepository = {
		async createBallot(input): Promise<SecretBallotRow> {
			const id = `ballot_${++ballotCounter}`;
			const now = new Date();
			const row: SecretBallotRow = makeRow({
				id,
				organizationId: input.organizationId,
				agentId: input.agentId ?? null,
				purpose: input.purpose,
				participants: input.participants,
				threshold: input.threshold,
				status: input.status ?? "open",
				tallyResult: input.tallyResult ?? null,
				expiresAt: input.expiresAt,
				metadata: input.metadata ?? {},
				createdAt: now,
				updatedAt: now,
			});
			store.set(id, row);
			return row;
		},
		async getBallot(id): Promise<SecretBallotRow | null> {
			return store.get(id) ?? null;
		},
		async listBallots(filter): Promise<SecretBallotRow[]> {
			return Array.from(store.values()).filter(
				(row) =>
					row.organizationId === filter.organizationId &&
					(!filter.status || row.status === filter.status),
			);
		},
		async updateBallot(id, patch): Promise<SecretBallotRow | null> {
			const existing = store.get(id);
			if (!existing) return null;
			const next: SecretBallotRow = {
				...existing,
				...(patch.status !== undefined ? { status: patch.status } : {}),
				...(patch.tallyResult !== undefined
					? { tallyResult: patch.tallyResult }
					: {}),
				...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
				updatedAt: new Date(),
			};
			store.set(id, next);
			return next;
		},
		async recordVote(input: RecordVoteInput): Promise<RecordVoteOutcome> {
			const existing = votes.find(
				(v) =>
					v.ballotId === input.ballotId &&
					v.participantIdentityId === input.participantIdentityId,
			);
			if (existing) {
				if (existing.valueCiphertext === input.valueCiphertext) {
					return { outcome: "replay_same_value", vote: existing };
				}
				return { outcome: "conflict_different_value", existing };
			}
			const row: SecretBallotVoteRow = {
				id: `vote_${++voteCounter}`,
				ballotId: input.ballotId,
				participantTokenHash: input.participantTokenHash,
				participantIdentityId: input.participantIdentityId,
				valueCiphertext: input.valueCiphertext,
				recordedAt: new Date(),
			};
			votes.push(row);
			return { outcome: "recorded", vote: row };
		},
		async findVoteByIdentity(ballotId, identityId): Promise<SecretBallotVoteRow | null> {
			return (
				votes.find(
					(v) =>
						v.ballotId === ballotId &&
						v.participantIdentityId === identityId,
				) ?? null
			);
		},
		async listVotes(ballotId): Promise<SecretBallotVoteRow[]> {
			return votes.filter((v) => v.ballotId === ballotId);
		},
		async countVotes(ballotId): Promise<number> {
			return votes.filter((v) => v.ballotId === ballotId).length;
		},
		async recordEvent(input): Promise<SecretBallotEventRow> {
			events.push(input);
			return {
				id: `event_${++eventCounter}`,
				ballotId: input.ballotId,
				eventName: input.eventName,
				redactedPayload: input.redactedPayload ?? {},
				occurredAt: new Date(),
			};
		},
		async expirePastBallots(now): Promise<string[]> {
			const expired: string[] = [];
			for (const [id, row] of store) {
				if (row.expiresAt.getTime() <= now.getTime() && row.status === "open") {
					store.set(id, { ...row, status: "expired", updatedAt: new Date() });
					expired.push(id);
				}
			}
			return expired;
		},
	} as unknown as SecretBallotsRepository;

	return { repo, store, votes, events };
}

function invalidCreateInput(input: Record<string, unknown>): CreateSecretBallotInput {
	return input as unknown as CreateSecretBallotInput;
}

describe("secretBallotsService", () => {
	let fake: FakeRepoState;
	let service: SecretBallotsService;

	beforeEach(() => {
		fake = makeFakeRepository();
		service = createSecretBallotsService({ repository: fake.repo });
	});

	test("create issues one scoped token per participant and persists hashes only", async () => {
		const result = await service.create({
			organizationId: ORG_ID,
			purpose: "Pick a winner",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});

		expect(result.participantTokens).toHaveLength(2);
		const tokens = result.participantTokens.map((t) => t.scopedToken);
		expect(new Set(tokens).size).toBe(2); // all unique
		expect(tokens.every((t) => t.startsWith("sb_"))).toBe(true);

		const stored = await fake.repo.getBallot(result.ballotId);
		expect(stored).not.toBeNull();
		const metadata = stored?.metadata as Record<string, unknown>;
		const hashes = metadata.tokenHashByIdentity as Record<string, string>;
		expect(Object.keys(hashes).sort()).toEqual(["u1", "u2"]);
		// hashes are sha256 hex (64 chars)
		for (const hash of Object.values(hashes)) {
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		}
		// raw tokens are NOT stored
		const storedSerialized = JSON.stringify(stored);
		for (const token of tokens) {
			expect(storedSerialized).not.toContain(token);
		}

		const created = fake.events.find((e) => e.eventName === "ballot.created");
		expect(created).toBeDefined();
	});

	test("create rejects threshold > participants", async () => {
		await expect(
			service.create({
				organizationId: ORG_ID,
				purpose: "x",
				participants: [{ identityId: "u1" }],
				threshold: 2,
			}),
		).rejects.toThrow(/threshold cannot exceed/);
	});

	test("create rejects duplicate participant identityId", async () => {
		await expect(
			service.create(
				invalidCreateInput({
					organizationId: ORG_ID,
					purpose: "x",
					participants: [{ identityId: "u1" }, { identityId: "u1" }],
					threshold: 1,
				}),
			),
		).rejects.toThrow(/duplicate participant/);
	});

	test("submitVote records new votes and is idempotent on replay with same value", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});
		const u1Token = created.participantTokens.find((t) => t.identityId === "u1")!
			.scopedToken;

		const first = await service.submitVote({
			ballotId: created.ballotId,
			scopedToken: u1Token,
			value: "yes",
		});
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.outcome).toBe("recorded");

		const second = await service.submitVote({
			ballotId: created.ballotId,
			scopedToken: u1Token,
			value: "yes",
		});
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.outcome).toBe("replay_same_value");

		// only one vote stored
		expect(fake.votes).toHaveLength(1);
	});

	test("submitVote rejects conflicting values for the same participant", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});
		const token = created.participantTokens[0].scopedToken;

		await service.submitVote({
			ballotId: created.ballotId,
			scopedToken: token,
			value: "yes",
		});
		const conflict = await service.submitVote({
			ballotId: created.ballotId,
			scopedToken: token,
			value: "no",
		});
		expect(conflict.ok).toBe(false);
		if (!conflict.ok) expect(conflict.reason).toBe("conflict_different_value");
	});

	test("submitVote rejects unknown tokens", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});
		const result = await service.submitVote({
			ballotId: created.ballotId,
			scopedToken: "sb_bogus",
			value: "yes",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("unknown_token");
	});

	test("tallyIfThresholdMet returns tallied=false until threshold hit, then tallied=true", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});

		const before = await service.tallyIfThresholdMet({ ballotId: created.ballotId });
		expect(before.tallied).toBe(false);
		expect(before.result).toBeNull();

		await service.submitVote({
			ballotId: created.ballotId,
			scopedToken: created.participantTokens[0].scopedToken,
			value: "yes",
		});
		const mid = await service.tallyIfThresholdMet({ ballotId: created.ballotId });
		expect(mid.tallied).toBe(false);

		await service.submitVote({
			ballotId: created.ballotId,
			scopedToken: created.participantTokens[1].scopedToken,
			value: "yes",
		});
		const after = await service.tallyIfThresholdMet({ ballotId: created.ballotId });
		expect(after.tallied).toBe(true);
		const tally = after.result as SecretBallotTallyResult;
		expect(tally.totalVotes).toBe(2);
		expect(tally.counts).toEqual({ yes: 2 });
		expect(tally.tallyMethod).toBe("plaintext_v1");

		// ballot status transitions to tallied and is idempotent
		expect(after.ballot.status).toBe("tallied");
		const again = await service.tallyIfThresholdMet({ ballotId: created.ballotId });
		expect(again.tallied).toBe(true);
	});

	test("tally events do NOT contain vote values or counts", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});
		await service.submitVote({
			ballotId: created.ballotId,
			scopedToken: created.participantTokens[0].scopedToken,
			value: "alpha",
		});
		await service.submitVote({
			ballotId: created.ballotId,
			scopedToken: created.participantTokens[1].scopedToken,
			value: "beta",
		});
		await service.tallyIfThresholdMet({ ballotId: created.ballotId });

		const tallied = fake.events.find((e) => e.eventName === "ballot.tallied");
		expect(tallied).toBeDefined();
		const payload = JSON.stringify(tallied?.redactedPayload ?? {});
		expect(payload).not.toContain("alpha");
		expect(payload).not.toContain("beta");
	});

	test("distribute rejects non-DM targets", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});
		await expect(
			service.distribute({
				ballotId: created.ballotId,
				target: "public_link" as unknown as "dm",
			}),
		).rejects.toThrow(/Unsupported distribution target/);
	});

	test("get returns null for cross-org lookup", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});
		expect(await service.get(created.ballotId, ORG_ID)).not.toBeNull();
		expect(await service.get(created.ballotId, "org-other")).toBeNull();
	});

	test("cancel transitions open → canceled", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});
		const canceled = await service.cancel({
			ballotId: created.ballotId,
			organizationId: ORG_ID,
			reason: "user changed mind",
		});
		expect(canceled.status).toBe("canceled");
		expect(fake.events.some((e) => e.eventName === "ballot.canceled")).toBe(true);
	});

	test("cancel rejects cross-org", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});
		await expect(
			service.cancel({ ballotId: created.ballotId, organizationId: "org-other" }),
		).rejects.toThrow(/does not belong to organization/);
	});

	test("expireBallot transitions open → expired", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});
		const expired = await service.expireBallot({
			ballotId: created.ballotId,
			organizationId: ORG_ID,
		});
		expect(expired.status).toBe("expired");
	});

	test("submitVote rejects when ballot already expired (status)", async () => {
		const created = await service.create({
			organizationId: ORG_ID,
			purpose: "x",
			participants: [{ identityId: "u1" }, { identityId: "u2" }],
			threshold: 2,
		});
		await service.expireBallot({
			ballotId: created.ballotId,
			organizationId: ORG_ID,
		});
		const result = await service.submitVote({
			ballotId: created.ballotId,
			scopedToken: created.participantTokens[0].scopedToken,
			value: "yes",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("ballot_not_open");
	});
});

describe("secretBallotsService — ballot lookup", () => {
	test("get returns null for missing ballot", async () => {
		const fake = makeFakeRepository();
		const service = createSecretBallotsService({ repository: fake.repo });
		expect(await service.get("missing", ORG_ID)).toBeNull();
	});

	test("expirePast sweeps past-expiry open ballots", async () => {
		const past = new Date(Date.now() - 60_000);
		const seed = makeRow({
			id: "ballot_old",
			expiresAt: past,
			status: "open" as SecretBallotStatus,
		});
		const fake = makeFakeRepository(seed);
		const service = createSecretBallotsService({ repository: fake.repo });
		const expired = await service.expirePast(new Date());
		expect(expired).toEqual(["ballot_old"]);
		expect(fake.events.some((e) => e.eventName === "ballot.expired")).toBe(true);
	});
});
