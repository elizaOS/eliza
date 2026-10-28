/**
 * Concurrent secret-ballot vote submits must stay idempotent.
 *
 * Two identical submits can both pass the repository's read-before-insert
 * lookup and then race on the (ballot_id, participant_identity_id) unique
 * index. The loser used to surface the raw insert failure, which the HTTP
 * route turns into a 500, even though the API contract for a repeat vote is
 * `replay_same_value` / `conflict_different_value`. The losing insert now
 * re-reads the winning row and returns that documented outcome.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

let closeDb: (() => Promise<void>) | undefined;
let repository: typeof import("../secret-ballots").secretBallotsRepository;
let dbWrite: typeof import("../../client").dbWrite;

const BALLOT_ID = "11111111-1111-1111-1111-111111111111";

beforeAll(async () => {
  ({ dbWrite, closeDatabaseConnectionsForTests: closeDb } = await import("../../client"));
  ({ secretBallotsRepository: repository } = await import("../secret-ballots"));

  await dbWrite.execute(`CREATE TABLE IF NOT EXISTS secret_ballot_votes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ballot_id uuid NOT NULL,
    participant_token_hash text NOT NULL,
    participant_identity_id text NOT NULL,
    value_ciphertext text NOT NULL,
    recorded_at timestamp with time zone NOT NULL DEFAULT now()
  )`);
  await dbWrite.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS secret_ballot_votes_ballot_identity_unique ON secret_ballot_votes (ballot_id, participant_identity_id)`,
  );
  await dbWrite.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS secret_ballot_votes_ballot_token_unique ON secret_ballot_votes (ballot_id, participant_token_hash)`,
  );
}, 120_000);

afterAll(async () => {
  await closeDb?.();
});

describe("secret ballot vote replay under concurrency", () => {
  test("two identical concurrent submits resolve to recorded + replay, one row", async () => {
    const submit = () =>
      repository.recordVote({
        ballotId: BALLOT_ID,
        participantTokenHash: "token-a",
        participantIdentityId: "identity-a",
        valueCiphertext: "vote:yes",
      });

    const results = await Promise.all([submit(), submit()]);
    const outcomes = results.map((result) => result.outcome).sort();

    expect(outcomes).toEqual(["recorded", "replay_same_value"]);
    expect(await repository.countVotes(BALLOT_ID)).toBe(1);
  });

  test("two different concurrent submits resolve to recorded + conflict", async () => {
    const results = await Promise.all([
      repository.recordVote({
        ballotId: BALLOT_ID,
        participantTokenHash: "token-b",
        participantIdentityId: "identity-b",
        valueCiphertext: "vote:yes",
      }),
      repository.recordVote({
        ballotId: BALLOT_ID,
        participantTokenHash: "token-b",
        participantIdentityId: "identity-b",
        valueCiphertext: "vote:no",
      }),
    ]);
    const outcomes = results.map((result) => result.outcome).sort();

    expect(outcomes).toEqual(["conflict_different_value", "recorded"]);
    expect(await repository.countVotes(BALLOT_ID)).toBe(2);
  });
});
