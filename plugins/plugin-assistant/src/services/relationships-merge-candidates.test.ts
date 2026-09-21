/**
 * Status guards on `RelationshipsService.acceptMerge`, `rejectMerge`, and
 * `proposeMerge`: unknown ids and already-resolved candidates surface as typed
 * `ElizaError`s instead of silent success, an applied merge is never relabelled
 * as rejected, a self-link is rejected, and a repeated pending proposal returns
 * the existing candidate. Drives the real service against PGlite identity
 * tables; no mocked SQL.
 */
import { PGlite } from "@electric-sql/pglite";
import { ElizaError, type IAgentRuntime, type UUID } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RELATIONSHIPS_MERGE_CANDIDATE_ALREADY_RESOLVED,
  RELATIONSHIPS_MERGE_CANDIDATE_NOT_FOUND,
  RELATIONSHIPS_MERGE_SAME_ENTITY,
  RelationshipsService,
} from "./relationships.ts";

const AGENT = "00000000-0000-4000-8000-000000000001" as UUID;
const PRIMARY = "00000000-0000-4000-8000-000000000002" as UUID;
const SECONDARY = "00000000-0000-4000-8000-000000000004" as UUID;
const MESSAGE = "00000000-0000-4000-8000-000000000003" as UUID;
const UNKNOWN_CANDIDATE = "00000000-0000-4000-8000-0000000000ff" as UUID;

async function createIdentityTables(client: PGlite): Promise<void> {
  await client.exec(`CREATE TABLE entity_identities (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
		entity_id uuid NOT NULL, agent_id uuid NOT NULL,
		platform text NOT NULL, handle text NOT NULL,
		verified boolean NOT NULL, confidence real NOT NULL, source text,
		first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL,
		evidence_message_ids jsonb, extraction_evidence jsonb,
		CONSTRAINT unique_entity_identity UNIQUE(entity_id, platform, handle, agent_id)
	);
	CREATE TABLE entity_merge_candidates (
		id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agent_id uuid NOT NULL,
		entity_a uuid NOT NULL,entity_b uuid NOT NULL,confidence real NOT NULL,
		evidence jsonb,status text NOT NULL,proposed_at timestamptz DEFAULT now(),resolved_at timestamptz
	)`);
}

async function candidateStatus(
  client: PGlite,
  candidateId: UUID,
): Promise<string | undefined> {
  const result = await client.query<{ status: string }>(
    "SELECT status FROM entity_merge_candidates WHERE id = $1",
    [candidateId],
  );
  return result.rows[0]?.status;
}

function expectMergeCandidateError(
  error: unknown,
  code: string,
  context: Record<string, unknown>,
): void {
  expect(error).toBeInstanceOf(ElizaError);
  const typed = error as ElizaError;
  expect(typed.code).toBe(code);
  expect(typed.context).toEqual(context);
}

function makeRuntime(client: PGlite): IAgentRuntime {
  return {
    agentId: AGENT,
    adapter: { db: drizzle(client) },
    getComponent: async () => null,
    getRelationships: async () => [],
    createRelationship: async () => true,
    updateRelationship: async () => undefined,
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  } as unknown as IAgentRuntime;
}

describe("RelationshipsService merge candidate status guards", () => {
  let client: PGlite;
  let service: RelationshipsService;

  beforeEach(async () => {
    client = new PGlite();
    await createIdentityTables(client);
    service = new RelationshipsService(makeRuntime(client));
    await service.upsertIdentity(
      SECONDARY,
      { platform: "github", handle: "example", confidence: 0.8 },
      [MESSAGE],
    );
  });

  afterEach(async () => {
    await client.close();
  });

  it("rejectMerge throws NOT_FOUND for an unknown candidate id", async () => {
    const error = await service.rejectMerge(UNKNOWN_CANDIDATE).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expectMergeCandidateError(error, RELATIONSHIPS_MERGE_CANDIDATE_NOT_FOUND, {
      candidateId: UNKNOWN_CANDIDATE,
    });
  });

  it("acceptMerge throws NOT_FOUND for an unknown candidate id", async () => {
    const error = await service.acceptMerge(UNKNOWN_CANDIDATE).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expectMergeCandidateError(error, RELATIONSHIPS_MERGE_CANDIDATE_NOT_FOUND, {
      candidateId: UNKNOWN_CANDIDATE,
    });
  });

  it("rejectMerge after acceptMerge throws ALREADY_RESOLVED and keeps the applied merge", async () => {
    const candidate = await service.proposeMerge(PRIMARY, SECONDARY, {
      platform: "github",
      handle: "example",
    });
    await service.acceptMerge(candidate);
    expect(await candidateStatus(client, candidate)).toBe("accepted");
    const folded = await service.getEntityIdentities(PRIMARY);
    expect(folded).toHaveLength(1);

    const error = await service.rejectMerge(candidate).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expectMergeCandidateError(
      error,
      RELATIONSHIPS_MERGE_CANDIDATE_ALREADY_RESOLVED,
      { candidateId: candidate, status: "accepted" },
    );
    expect(await candidateStatus(client, candidate)).toBe("accepted");
    expect(await service.getEntityIdentities(PRIMARY)).toEqual(folded);
    expect(await service.getEntityIdentities(SECONDARY)).toEqual([]);
  });

  it("acceptMerge after rejectMerge throws ALREADY_RESOLVED without folding", async () => {
    const candidate = await service.proposeMerge(PRIMARY, SECONDARY, {
      platform: "github",
      handle: "example",
    });
    await service.rejectMerge(candidate);
    expect(await candidateStatus(client, candidate)).toBe("rejected");

    const error = await service.acceptMerge(candidate).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expectMergeCandidateError(
      error,
      RELATIONSHIPS_MERGE_CANDIDATE_ALREADY_RESOLVED,
      { candidateId: candidate, status: "rejected" },
    );
    expect(await candidateStatus(client, candidate)).toBe("rejected");
    expect(await service.getEntityIdentities(PRIMARY)).toEqual([]);
    expect(await service.getEntityIdentities(SECONDARY)).toHaveLength(1);
  });

  it("rejectMerge resolves a pending candidate exactly once", async () => {
    const candidate = await service.proposeMerge(PRIMARY, SECONDARY, {
      platform: "github",
      handle: "example",
    });
    await service.rejectMerge(candidate);
    expect(await service.getCandidateMerges()).toEqual([]);

    const error = await service.rejectMerge(candidate).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expectMergeCandidateError(
      error,
      RELATIONSHIPS_MERGE_CANDIDATE_ALREADY_RESOLVED,
      { candidateId: candidate, status: "rejected" },
    );
  });

  it("proposeMerge throws SAME_ENTITY when both ids are equal", async () => {
    const error = await service.proposeMerge(PRIMARY, PRIMARY, {}).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expectMergeCandidateError(error, RELATIONSHIPS_MERGE_SAME_ENTITY, {
      entityId: PRIMARY,
    });
  });

  it("proposeMerge returns the existing pending candidate for an identical pair", async () => {
    const first = await service.proposeMerge(PRIMARY, SECONDARY, {
      platform: "github",
      handle: "example",
    });
    const second = await service.proposeMerge(PRIMARY, SECONDARY, {
      platform: "github",
      handle: "example-again",
    });
    expect(second).toBe(first);
    const pending = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM entity_merge_candidates WHERE agent_id = $1 AND status = 'pending'",
      [AGENT],
    );
    expect(pending.rows[0]?.count).toBe("1");
  });
});
