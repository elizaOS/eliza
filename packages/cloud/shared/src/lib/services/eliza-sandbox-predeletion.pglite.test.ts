/**
 * Real-PGlite proof of the #18517 retention contract: `agent_sandbox_backups`
 * is ON DELETE CASCADE and is destroyed by the sandbox row's deletion, while
 * `agent_sandbox_predeletion_backups` deliberately has no foreign key and
 * survives the same parent delete. Runs actual DDL and a real row delete —
 * no mocks stand in for the database behavior under test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import {
  agentSandboxBackups,
  agentSandboxes,
  agentSandboxPredeletionBackups,
} from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { dockerNodes } from "../../db/schemas/docker-nodes";
import { generations } from "../../db/schemas/generations";
import { jobExecutionLeases } from "../../db/schemas/job-execution-leases";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { usageRecords } from "../../db/schemas/usage-records";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const schema = {
      organizations,
      users,
      userCharacters,
      apiKeys,
      usageRecords,
      generations,
      dockerNodes,
      agentSandboxes,
      agentSandboxBackups,
      agentSandboxPredeletionBackups,
      jobs,
      jobExecutionLeases,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentSandboxPredeletionBackups);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("pre-deletion retention survives a real parent delete (#18517)", () => {
  test("the sandbox row's deletion cascades agent_sandbox_backups but not the retention row", async () => {
    const [org] = await dbWrite
      .insert(organizations)
      .values({ name: "Retention Org", slug: `retention-org-${Date.now()}` })
      .returning();
    const [actor] = await dbWrite
      .insert(users)
      .values({ steward_user_id: `retention-actor-${Date.now()}`, organization_id: org.id })
      .returning();
    const agentId = "00000000-0000-4000-8000-000000018517";
    const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await dbWrite.insert(agentSandboxes).values({
      id: agentId,
      organization_id: org.id,
      user_id: actor.id,
      agent_name: "Retention Agent",
      status: "deletion_pending",
      sandbox_id: "sandbox-18517",
      deletion_attempt_id: attemptId,
      deletion_started_at: new Date(),
    });
    await dbWrite.insert(agentSandboxBackups).values({
      sandbox_record_id: agentId,
      snapshot_type: "pre-shutdown",
      state_data: { tables: {} } as never,
    });
    await dbWrite.insert(agentSandboxPredeletionBackups).values({
      organization_id: org.id,
      agent_id: agentId,
      deletion_attempt_id: attemptId,
      lifecycle_revision: 1,
      sandbox_id: "sandbox-18517",
      bridge_url: "https://bridge-18517.example",
      capture_unsupported: false,
      state_data: { tables: {} } as never,
      size_bytes: 42,
    });

    // The real parent delete — the exact statement commitAgentRowDelete runs.
    await dbWrite.delete(agentSandboxes).where(eq(agentSandboxes.id, agentId));

    const cascaded = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.sandbox_record_id, agentId));
    expect(cascaded).toEqual([]);

    const retained = await dbWrite
      .select()
      .from(agentSandboxPredeletionBackups)
      .where(eq(agentSandboxPredeletionBackups.agent_id, agentId));
    expect(retained).toHaveLength(1);
    expect(retained[0].deletion_attempt_id).toBe(attemptId);
    expect(retained[0].sandbox_id).toBe("sandbox-18517");
    expect(retained[0].size_bytes).toBe(42);
  });
});
