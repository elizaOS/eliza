import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../../packages/core/src/database/inMemoryAdapter.ts";
import { AgentRuntime } from "../../../../packages/core/src/runtime.ts";
import type {
  IAgentRuntime,
  UUID,
} from "../../../../packages/core/src/types/index.ts";
import { createAssistantPlugin } from "../index.ts";
import { RelationshipsService } from "./relationships.ts";

const AGENT = "00000000-0000-4000-8000-000000000001" as UUID;
const ENTITY = "00000000-0000-4000-8000-000000000002" as UUID;
const FIRST = "00000000-0000-4000-8000-000000000003" as UUID;
const SECOND = "00000000-0000-4000-8000-000000000004" as UUID;
const ROOM = "00000000-0000-4000-8000-000000000005" as UUID;
const OTHER_ROOM = "00000000-0000-4000-8000-000000000006" as UUID;

async function createIdentityTables(client: PGlite) {
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

describe("Identity ownership at the SQL write boundary", () => {
  it.each(["manual", "import", undefined, "reflection"])(
    "preserves existing %s ownership when reflection strengthens a claim",
    async (source) => {
      const client = new PGlite();
      try {
        await client.exec(`CREATE TABLE entity_identities (
					id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
					entity_id uuid NOT NULL, agent_id uuid NOT NULL,
					platform text NOT NULL, handle text NOT NULL,
					verified boolean NOT NULL, confidence real NOT NULL, source text,
					first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL,
					evidence_message_ids jsonb, extraction_evidence jsonb,
					CONSTRAINT unique_entity_identity UNIQUE(entity_id, platform, handle, agent_id)
				)`);
        const service = new RelationshipsService({
          agentId: AGENT,
          adapter: { db: drizzle(client) },
        } as unknown as IAgentRuntime);
        await service.upsertIdentity(
          ENTITY,
          {
            platform: "github",
            handle: "example",
            confidence: 0.7,
            source,
          },
          [FIRST],
        );
        await service.upsertIdentity(
          ENTITY,
          {
            platform: "github",
            handle: "example",
            confidence: 0.8,
            source: "reflection",
          },
          [SECOND],
        );
        const [identity] = await service.getEntityIdentities(ENTITY);
        expect(identity.source).toBe(source);
        expect(identity.confidence).toBeCloseTo(0.8);
        expect(new Set(identity.evidenceMessageIds)).toEqual(
          new Set([FIRST, SECOND]),
        );
        // A later explicit verification still takes ownership of the claim.
        await service.upsertIdentity(ENTITY, {
          platform: "github",
          handle: "example",
          confidence: 0.9,
          verified: true,
          source: "manual",
        });
        await service.upsertIdentity(
          ENTITY,
          {
            platform: "github",
            handle: "example",
            confidence: 0.8,
            source: "reflection",
          },
          [SECOND],
        );
        expect((await service.getEntityIdentities(ENTITY))[0]).toMatchObject({
          source: "manual",
          verified: true,
          confidence: expect.closeTo(0.9),
        });
      } finally {
        await client.close();
      }
    },
  );
});

describe("Identity merge provenance", () => {
  it("rolls back merged evidence on deletion failure and leaves other agents untouched", async () => {
    const client = new PGlite();
    try {
      await createIdentityTables(client);
      const adapter = Object.assign(new InMemoryDatabaseAdapter(), {
        db: drizzle(client),
      });
      const runtime = new AgentRuntime({
        plugins: [createAssistantPlugin()],
        character: { name: "MergeRollbackQA", bio: "test" },
        adapter,
        logLevel: "fatal",
      });
      await runtime.createEntities([
        { id: ENTITY, agentId: runtime.agentId, names: ["Primary"] },
        { id: SECOND, agentId: runtime.agentId, names: ["Secondary"] },
      ]);
      const service = new RelationshipsService(runtime);
      const foreign = new RelationshipsService({
        agentId: AGENT,
        adapter: { db: drizzle(client) },
      } as unknown as IAgentRuntime);
      await service.upsertIdentity(
        ENTITY,
        {
          platform: "github",
          handle: "example",
          source: "reflection",
          confidence: 0.7,
        },
        [FIRST],
      );
      await service.upsertIdentity(
        SECOND,
        {
          platform: "github",
          handle: "example",
          source: "manual",
          confidence: 0.8,
        },
        [SECOND],
      );
      await foreign.upsertIdentity(
        SECOND,
        {
          platform: "github",
          handle: "example",
          source: "import",
          confidence: 0.9,
        },
        [ENTITY],
      );
      const before = await client.query(
        "SELECT * FROM entity_identities ORDER BY agent_id,entity_id",
      );
      const candidate = await service.proposeMerge(ENTITY, SECOND, {
        platform: "github",
        handle: "example",
      });
      await client.exec(`CREATE FUNCTION deny_identity_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test merge deletion failure'; END $$;
				CREATE TRIGGER deny_identity_delete BEFORE DELETE ON entity_identities FOR EACH ROW EXECUTE FUNCTION deny_identity_delete()`);
      await expect(service.acceptMerge(candidate)).rejects.toThrow();
      expect(
        (
          await client.query(
            "SELECT * FROM entity_identities ORDER BY agent_id,entity_id",
          )
        ).rows,
      ).toEqual(before.rows);
      expect((await service.getCandidateMerges()).map((row) => row.id)).toEqual(
        [candidate],
      );
      expect(
        await runtime.getRelationships({ entityIds: [ENTITY, SECOND] }),
      ).toEqual([]);
      const foreignBefore = await foreign.getEntityIdentities(SECOND);
      await client.exec(
        "DROP TRIGGER deny_identity_delete ON entity_identities",
      );
      await service.acceptMerge(candidate);
      expect(await foreign.getEntityIdentities(SECOND)).toEqual(foreignBefore);
      const [merged] = await service.getEntityIdentities(ENTITY);
      expect(merged.source).toBe("manual");
      expect(new Set(merged.evidenceMessageIds)).toEqual(
        new Set([FIRST, SECOND]),
      );
    } finally {
      await client.close();
    }
  });
  it.each([
    ["reflection", "manual", "manual"],
    ["manual", "reflection", "manual"],
    ["reflection", undefined, undefined],
    [undefined, "reflection", undefined],
    ["reflection", "reflection", "reflection"],
  ])(
    "merges %s and %s support without losing ownership or evidence",
    async (leftSource, rightSource, expectedSource) => {
      const client = new PGlite();
      try {
        await createIdentityTables(client);
        const adapter = Object.assign(new InMemoryDatabaseAdapter(), {
          db: drizzle(client),
        });
        const runtime = new AgentRuntime({
          plugins: [createAssistantPlugin()],
          character: { name: "MergeEvidenceQA", bio: "test" },
          adapter,
          logLevel: "fatal",
        });
        await runtime.createEntities([
          { id: ENTITY, agentId: runtime.agentId, names: ["Primary"] },
          { id: SECOND, agentId: runtime.agentId, names: ["Secondary"] },
        ]);
        const service = new RelationshipsService(runtime);
        await service.upsertIdentity(
          ENTITY,
          {
            platform: "github",
            handle: "example",
            source: leftSource,
            confidence: 0.7,
          },
          [FIRST],
        );
        await service.upsertIdentity(
          SECOND,
          {
            platform: "github",
            handle: "example",
            source: rightSource,
            confidence: 0.8,
            verified: true,
          },
          [SECOND],
        );
        await client.query(
          "UPDATE entity_identities SET first_seen = $1, last_seen = $2, extraction_evidence = NULL WHERE entity_id = $3",
          ["2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z", ENTITY],
        );
        await client.query(
          "UPDATE entity_identities SET first_seen = $1, last_seen = $2, extraction_evidence = NULL WHERE entity_id = $3",
          ["2026-09-01T00:00:00Z", "2026-09-04T00:00:00Z", SECOND],
        );
        const candidate = await service.proposeMerge(ENTITY, SECOND, {
          platform: "github",
          handle: "example",
        });
        await service.acceptMerge(candidate);
        const [identity] = await service.getEntityIdentities(ENTITY);
        expect(identity.source).toBe(expectedSource);
        expect(identity.firstSeen).toBe("2026-09-01T00:00:00.000Z");
        expect(identity.lastSeen).toBe("2026-09-04T00:00:00.000Z");
        expect(identity.verified).toBe(true);
        expect(identity.confidence).toBeCloseTo(0.8);
        expect(new Set(identity.evidenceMessageIds)).toEqual(
          new Set([FIRST, SECOND]),
        );
        expect(await service.getEntityIdentities(SECOND)).toEqual([]);
        expect(await service.getCandidateMerges()).toEqual([]);
        const links = await runtime.getRelationships({
          entityIds: [ENTITY, SECOND],
        });
        expect(links).toHaveLength(1);
        expect(links[0].metadata).toMatchObject({
          status: "confirmed",
          mergeSurvivorEntityId: ENTITY,
        });
        await service.acceptMerge(candidate);
        expect(await service.getEntityIdentities(ENTITY)).toEqual([identity]);
        expect(
          await runtime.getRelationships({ entityIds: [ENTITY, SECOND] }),
        ).toEqual(links);
      } finally {
        await client.close();
      }
    },
  );
});

describe("Source-owned identity reconciliation", () => {
  async function setup() {
    const client = new PGlite();
    await createIdentityTables(client);
    const adapter = Object.assign(new InMemoryDatabaseAdapter(), {
      db: drizzle(client),
    });
    const runtime = new AgentRuntime({
      plugins: [createAssistantPlugin()],
      character: { name: "IdentityReconciliationQA", bio: "test" },
      adapter,
      logLevel: "fatal",
    });
    await runtime.createEntities([
      { id: ENTITY, agentId: runtime.agentId, names: ["Primary"] },
      { id: SECOND, agentId: runtime.agentId, names: ["Secondary"] },
    ]);
    return { client, runtime, service: new RelationshipsService(runtime) };
  }
  const claim = { platform: "github", handle: "example", confidence: 0.9 };
  const first = {
    evidenceId: "first",
    roomId: ROOM,
    sourceMessageId: FIRST,
    sourceRevisions: { [FIRST]: "revision1" },
  };
  const second = {
    evidenceId: "second",
    roomId: OTHER_ROOM,
    sourceMessageId: SECOND,
    sourceRevisions: { [SECOND]: "revision1" },
  };
  const edit = {
    id: "edit-first",
    changedMessageIds: [FIRST],
    removedMessageIds: [],
    currentSourceRevisions: { [FIRST]: "revision2" },
  };

  it("downgrades confidence, preserves another room's support, retires without deleting and replays exactly", async () => {
    const { client, service } = await setup();
    try {
      await Promise.all([
        service.upsertExtractedIdentity(ENTITY, claim, first),
        service.upsertExtractedIdentity(
          ENTITY,
          { ...claim, confidence: 0.7 },
          second,
        ),
      ]);
      expect(
        (await service.getEntityIdentities(ENTITY))[0].confidence,
      ).toBeCloseTo(0.9);
      expect(await service.reconcileIdentityEvidence(ROOM, edit)).toEqual({
        reprocessSourceIds: [FIRST],
      });
      const [remaining] = await service.getEntityIdentities(ENTITY);
      expect(remaining.confidence).toBeCloseTo(0.7);
      expect(remaining.evidenceMessageIds).toEqual([SECOND]);
      const snapshot = (await client.query("SELECT * FROM entity_identities"))
        .rows;
      expect(await service.reconcileIdentityEvidence(ROOM, edit)).toEqual({
        reprocessSourceIds: [FIRST],
      });
      expect(
        (await client.query("SELECT * FROM entity_identities")).rows,
      ).toEqual(snapshot);
      await service.reconcileIdentityEvidence(OTHER_ROOM, {
        id: "remove-second",
        changedMessageIds: [],
        removedMessageIds: [SECOND],
        currentSourceRevisions: {},
      });
      expect(await service.getEntityIdentities(ENTITY)).toEqual([]);
      expect(
        (await client.query("SELECT * FROM entity_identities")).rows,
      ).toHaveLength(1);
      // A retired claim cannot trigger an automatic identity collision.
      await service.upsertIdentity(
        SECOND,
        { ...claim, confidence: 1, source: "manual" },
        [FIRST, SECOND],
      );
      expect(await service.getCandidateMerges()).toEqual([]);
      await service.upsertExtractedIdentity(
        ENTITY,
        { ...claim, confidence: 0.8 },
        {
          ...first,
          evidenceId: "new-revision",
          sourceRevisions: { [FIRST]: "revision2" },
        },
      );
      expect(
        (await service.getEntityIdentities(ENTITY))[0].confidence,
      ).toBeCloseTo(0.8);
      const rows = (
        await client.query(
          "SELECT extraction_evidence FROM entity_identities WHERE entity_id = $1",
          [ENTITY],
        )
      ).rows;
      expect(
        Object.values(
          (
            rows[0].extraction_evidence as {
              observations: Record<string, { retiredBy?: string }>;
            }
          ).observations,
        ).filter((row) => row.retiredBy),
      ).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("restores the independent manual baseline rather than the removed observation's confidence", async () => {
    const { client, service } = await setup();
    try {
      await service.upsertIdentity(
        ENTITY,
        { ...claim, confidence: 0.6, verified: true, source: "manual" },
        [SECOND],
      );
      await service.upsertExtractedIdentity(
        ENTITY,
        { ...claim, confidence: 0.95 },
        first,
      );
      await service.upsertIdentity(
        ENTITY,
        { ...claim, confidence: 0.8, source: "import" },
        [SECOND],
      );
      await service.reconcileIdentityEvidence(ROOM, edit);
      const [identity] = await service.getEntityIdentities(ENTITY);
      expect(identity.confidence).toBeCloseTo(0.8);
      expect(identity.verified).toBe(true);
      expect(identity.source).toBe("import");
      expect(identity.evidenceMessageIds).toEqual([SECOND]);
    } finally {
      await client.close();
    }
  });

  it("keeps observations through a confirmed merge and retires support without undoing the confirmation", async () => {
    const { client, service, runtime } = await setup();
    try {
      await service.upsertExtractedIdentity(ENTITY, claim, first);
      await service.upsertExtractedIdentity(
        SECOND,
        { ...claim, confidence: 0.7 },
        second,
      );
      const candidate = await service.proposeMerge(ENTITY, SECOND, {
        platform: "github",
        handle: "example",
      });
      await service.acceptMerge(candidate);
      const links = await runtime.getRelationships({
        entityIds: [ENTITY, SECOND],
      });
      await service.reconcileIdentityEvidence(ROOM, edit);
      const [identity] = await service.getEntityIdentities(ENTITY);
      expect(identity.confidence).toBeCloseTo(0.7);
      expect(identity.evidenceMessageIds).toEqual([SECOND]);
      expect(
        await runtime.getRelationships({ entityIds: [ENTITY, SECOND] }),
      ).toEqual(links);
    } finally {
      await client.close();
    }
  });

  it("rolls back a failed observation write and retries once without duplicates", async () => {
    const { client, service } = await setup();
    try {
      await client.exec(`CREATE FUNCTION deny_observation_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test observation failure'; END $$;
			CREATE TRIGGER deny_observation_write BEFORE UPDATE ON entity_identities FOR EACH ROW EXECUTE FUNCTION deny_observation_write()`);
      await expect(
        service.upsertExtractedIdentity(ENTITY, claim, first),
      ).rejects.toThrow();
      expect(
        (await client.query("SELECT * FROM entity_identities")).rows,
      ).toEqual([]);
      await client.exec(
        "DROP TRIGGER deny_observation_write ON entity_identities",
      );
      await service.upsertExtractedIdentity(ENTITY, claim, first);
      const before = (await client.query("SELECT * FROM entity_identities"))
        .rows;
      await service.upsertExtractedIdentity(ENTITY, claim, first);
      expect(
        (await client.query("SELECT * FROM entity_identities")).rows,
      ).toEqual(before);
    } finally {
      await client.close();
    }
  });

  it("does not pretend unknown legacy reflection ownership was reconstructed", async () => {
    const { client, service } = await setup();
    try {
      await service.upsertIdentity(ENTITY, { ...claim, source: "reflection" }, [
        FIRST,
      ]);
      await expect(
        service.reconcileIdentityEvidence(ROOM, edit),
      ).rejects.toMatchObject({
        code: "EVALUATOR_IDENTITY_LEGACY_REVIEW_REQUIRED",
      });
      expect(await service.getEntityIdentities(ENTITY)).toHaveLength(1);
      const rows = (
        await client.query("SELECT extraction_evidence FROM entity_identities")
      ).rows;
      expect(rows[0].extraction_evidence).toMatchObject({
        reviewRequired: true,
      });
    } finally {
      await client.close();
    }
  });
});
