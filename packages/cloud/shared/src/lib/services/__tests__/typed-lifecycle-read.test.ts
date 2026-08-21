/**
 * Exercises typed lifecycle reads and database-owned sandbox generations
 * against a real in-process PostgreSQL-compatible database.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("typed-lifecycle-read.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { agentBackupObjects } from "../../../db/schemas/agent-backup-catalog";
import {
  type AgentSandbox,
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../../db/schemas/api-keys";
import { generations } from "../../../db/schemas/generations";
import { jobs } from "../../../db/schemas/jobs";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import { hasReadyWarmClaimCredential } from "../warm-claim-key-push";

const TEST_TIMEOUT = 300_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;
let agentSandboxesRepository: typeof import("../../../db/repositories/agent-sandboxes").agentSandboxesRepository;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOwner(): Promise<{ orgId: string; userId: string }> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: unique("org"), credit_balance: "5.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: unique("steward"), organization_id: organization.id })
    .returning();
  return { orgId: organization.id, userId: user.id };
}

async function seedRunningAgent(orgId: string, userId: string): Promise<AgentSandbox> {
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: orgId,
      user_id: userId,
      agent_name: unique("agent"),
      status: "running",
      execution_tier: "dedicated-always",
      environment_vars: { ELIZA_API_TOKEN: "test-agent-token" },
    })
    .returning();
  return sandbox;
}

async function seedFreshVerifiedBackup(sandboxRecordId: string): Promise<void> {
  await dbWrite.insert(agentSandboxBackups).values({
    sandbox_record_id: sandboxRecordId,
    snapshot_type: "pre-shutdown",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    size_bytes: 2,
    verification_status: "verified",
    verified_at: new Date(),
  });
}

async function applyLifecycleRevisionMigration(): Promise<void> {
  const migration = await readFile(
    join(import.meta.dir, "../../../db/migrations/0187_agent_sandbox_lifecycle_revision.sql"),
    "utf8",
  );
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await dbWrite.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ ElizaSandboxService } = await import("../eliza-sandbox"));
  ({ agentSandboxesRepository } = await import("../../../db/repositories/agent-sandboxes"));
  const schema = {
    organizations,
    users,
    userCharacters,
    agentSandboxes,
    agentSandboxBackups,
    agentBackupCatalogAuthorities,
    agentBackupObjects,
    apiKeys,
    generations,
    usageRecords,
    jobs,
  };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
  await applyLifecycleRevisionMigration();
}, TEST_TIMEOUT);

afterAll(async () => {
  await closeDb();
});

describe("typed lifecycle reads and exact sandbox generations", () => {
  test(
    "a locked lifecycle read maps timestamps to Dates for the warm-claim gate",
    async () => {
      const { orgId, userId } = await seedOwner();
      const [sandbox] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: unique("claimed"),
          status: "running",
          execution_tier: "dedicated-always",
          claimed_at: new Date(),
          warm_claim_credential_state: "ready",
          warm_claim_key_fingerprint: "fingerprint",
          warm_claim_attested_at: new Date(),
          warm_claim_attested_environment_revision: 0,
        })
        .returning();

      const service = new ElizaSandboxService() as unknown as {
        getAgentForLifecycleMutation: (
          tx: unknown,
          agentId: string,
          organizationId: string,
        ) => Promise<AgentSandbox | undefined>;
      };
      const locked = await dbWrite.transaction(async (tx) =>
        service.getAgentForLifecycleMutation(tx, sandbox.id, orgId),
      );

      expect(locked?.updated_at).toBeInstanceOf(Date);
      expect(locked?.claimed_at).toBeInstanceOf(Date);
      expect(locked?.warm_claim_attested_at).toBeInstanceOf(Date);
      expect(locked && hasReadyWarmClaimCredential(locked)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "raw same-millisecond writers receive distinct database-owned revisions",
    async () => {
      const { orgId, userId } = await seedOwner();
      const sandbox = await seedRunningAgent(orgId, userId);
      const fixedTimestamp = new Date("2026-07-30T12:00:00.123Z");

      await Promise.all([
        dbWrite.execute(sql`
          UPDATE ${agentSandboxes}
          SET
            error_count = error_count + 1,
            lifecycle_revision = -100,
            updated_at = ${fixedTimestamp}
          WHERE id = ${sandbox.id}
        `),
        dbWrite.execute(sql`
          UPDATE ${agentSandboxes}
          SET
            error_count = error_count + 1,
            lifecycle_revision = -200,
            updated_at = ${fixedTimestamp}
          WHERE id = ${sandbox.id}
        `),
      ]);

      const [updated] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      expect(updated.lifecycle_revision).toBe(sandbox.lifecycle_revision + 2);
      expect(updated.error_count).toBe(2);
      expect(updated.updated_at.getTime()).toBe(fixedTimestamp.getTime());
    },
    TEST_TIMEOUT,
  );

  test(
    "heartbeat writeback loses to a same-millisecond microsecond mutation",
    async () => {
      const { orgId, userId } = await seedOwner();
      const sandbox = await seedRunningAgent(orgId, userId);
      const observedTimestamp = new Date("2026-07-30T12:00:00.123Z");
      let observed: AgentSandbox | undefined;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async () => {
          if (!observed)
            throw new Error("heartbeat probe arrived before its generation was seeded");
          await dbWrite.execute(sql`
            UPDATE ${agentSandboxes}
            SET
              error_count = error_count + 1,
              updated_at = '2026-07-30 12:00:00.123789+00'::timestamptz
            WHERE id = ${sandbox.id}
          `);
          return new Response("ok");
        },
      });

      try {
        const port = server.port;
        observed = (
          await dbWrite
            .update(agentSandboxes)
            .set({
              bridge_url: `http://127.0.0.1:${port}`,
              health_url: `http://127.0.0.1:${port}`,
              node_id: "test-node",
              bridge_port: port,
              headscale_ip: "127.0.0.1",
              last_heartbeat_at: new Date(),
              updated_at: observedTimestamp,
            })
            .where(eq(agentSandboxes.id, sandbox.id))
            .returning()
        )[0];

        const healthy = await new ElizaSandboxService().heartbeat(sandbox.id, orgId);

        expect(healthy).toBe(false);
        const current = await agentSandboxesRepository.findByIdAndOrg(sandbox.id, orgId);
        expect(current?.status).toBe("running");
        expect(current?.lifecycle_revision).toBe(observed.lifecycle_revision + 1);
        expect(current?.updated_at.getTime()).toBe(observed.updated_at.getTime());
      } finally {
        server.stop(true);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "sleep rejects a same-millisecond mutation prepared during snapshot I/O",
    async () => {
      const { orgId, userId } = await seedOwner();
      const sandbox = await seedRunningAgent(orgId, userId);
      await seedFreshVerifiedBackup(sandbox.id);
      let observed: AgentSandbox | undefined;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async () => {
          if (!observed) throw new Error("snapshot arrived before its generation was seeded");
          await dbWrite.execute(sql`
            UPDATE ${agentSandboxes}
            SET error_count = error_count + 1, updated_at = ${observed.updated_at}
            WHERE id = ${sandbox.id}
          `);
          return Response.json({ memories: [], config: {}, workspaceFiles: {} });
        },
      });

      try {
        const port = server.port;
        observed = (
          await dbWrite
            .update(agentSandboxes)
            .set({
              bridge_url: `http://127.0.0.1:${port}`,
              health_url: `http://127.0.0.1:${port}`,
              node_id: "test-node",
              bridge_port: port,
              headscale_ip: "127.0.0.1",
            })
            .where(eq(agentSandboxes.id, sandbox.id))
            .returning()
        )[0];

        const result = await new ElizaSandboxService().executeSleep(sandbox.id, orgId);

        expect(result).toMatchObject({
          success: false,
          containerRemoved: false,
          error: "Agent lifecycle changed while sleep was prepared",
        });
        const current = await agentSandboxesRepository.findByIdAndOrg(sandbox.id, orgId);
        expect(current?.status).toBe("running");
        expect(current?.lifecycle_revision).toBe(observed.lifecycle_revision + 1);
        expect(current?.updated_at.getTime()).toBe(observed.updated_at.getTime());
      } finally {
        server.stop(true);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "sleep commits against the exact revision and advances it",
    async () => {
      const { orgId, userId } = await seedOwner();
      const sandbox = await seedRunningAgent(orgId, userId);
      await seedFreshVerifiedBackup(sandbox.id);

      const result = await new ElizaSandboxService().executeSleep(sandbox.id, orgId);

      expect(result.success).toBe(true);
      const current = await agentSandboxesRepository.findByIdAndOrg(sandbox.id, orgId);
      expect(current?.status).toBe("sleeping");
      expect(current?.lifecycle_revision).toBe(sandbox.lifecycle_revision + 1);
    },
    TEST_TIMEOUT,
  );
  test(
    "a raw SQL writer advances the revision, so a CAS holding the pre-write value loses",
    async () => {
      const { orgId, userId } = await seedOwner();
      const sandbox = await seedRunningAgent(orgId, userId);
      const observed = {
        organizationId: orgId,
        environmentRevision: sandbox.environment_revision,
        sandboxId: sandbox.sandbox_id,
        nodeId: sandbox.node_id,
        containerName: sandbox.container_name,
        lifecycleRevision: sandbox.lifecycle_revision,
      };

      // Exactly the writer the timestamp fence could not see: a raw statement
      // that sets updated_at itself, with microsecond precision PGlite's own
      // NOW() cannot produce. Under the eq() fence the CAS still matched after
      // this write; the trigger now moves the revision whatever the statement
      // touches.
      await dbWrite.execute(
        sql`UPDATE agent_sandboxes
            SET updated_at = TIMESTAMP '2026-07-23 11:59:00.123456'
            WHERE id = ${sandbox.id}`,
      );
      const afterRawWrite = await agentSandboxesRepository.findByIdAndOrg(sandbox.id, orgId);
      expect(afterRawWrite?.lifecycle_revision).toBe(sandbox.lifecycle_revision + 1);

      const stale = await agentSandboxesRepository.update(
        sandbox.id,
        { status: "sleeping" },
        observed,
      );

      expect(stale).toBeUndefined();
      const unchanged = await agentSandboxesRepository.findByIdAndOrg(sandbox.id, orgId);
      expect(unchanged?.status).toBe("running");

      // The same call carrying the revision the raw write left behind commits,
      // so the refusal above is the fence and not an unrelated rejection.
      const fresh = await agentSandboxesRepository.update(
        sandbox.id,
        { status: "sleeping" },
        { ...observed, lifecycleRevision: afterRawWrite?.lifecycle_revision ?? -1 },
      );

      expect(fresh?.status).toBe("sleeping");
      expect(fresh?.lifecycle_revision).toBe(sandbox.lifecycle_revision + 2);
    },
    TEST_TIMEOUT,
  );
});
