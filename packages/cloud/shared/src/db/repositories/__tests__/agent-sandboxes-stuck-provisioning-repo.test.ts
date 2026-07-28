/**
 * The stuck-provisioning sweeper must never call an IN-FLIGHT cold boot
 * abandoned (#17215), against the REAL Drizzle schema on in-process PGlite.
 *
 * `provisioning` is held by every job type that reaches `provision()` — not
 * just `agent_provision`/`agent_restart`, but `agent_wake` and `agent_resume`
 * too. A cold boot pays an image pull plus a container create plus a tailnet
 * health poll and refreshes nothing in between, so a sweeper that exempts only
 * some of those types flips a live boot to terminal `error`; `error` is then
 * reapable by the orphan reconciler with no age grace, destroying the container
 * under the running job. That is the mechanism behind 19 of the 44 agents
 * stranded on 2026-07-13 (#17162).
 *
 * Harness mirrors `agent-sandboxes-fleet-candidate-repo.test.ts`: drizzle-kit
 * `pushSchema` applies the exact DDL from the real schema objects to the same
 * PGlite connection the repository queries through. Fails LOUDLY (never
 * silently passes) when a shared non-PGlite Postgres is the ambient DATABASE_URL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { apiKeys } from "../../schemas/api-keys";
import { generations } from "../../schemas/generations";
import { jobs } from "../../schemas/jobs";
import { organizations } from "../../schemas/organizations";
import { usageRecords } from "../../schemas/usage-records";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import { AgentSandboxesRepository } from "../agent-sandboxes";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

const repo = new AgentSandboxesRepository();

/** Row age: older than the cutoff, so only the job-type exemption can save it. */
const LONG_AGO = new Date(Date.now() - 60 * 60 * 1000);
/** Sweep everything older than 20 minutes — LONG_AGO is well past it. */
const SWEEP_CUTOFF = new Date(Date.now() - 20 * 60 * 1000);

async function seedOrgAndUser(): Promise<{ organizationId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Sweeper Org", slug: uniq("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  return { organizationId: org.id, userId: user.id };
}

async function seedProvisioningAgent(organizationId: string, userId: string): Promise<string> {
  const [row] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organizationId,
      user_id: userId,
      agent_name: uniq("agent"),
      status: "provisioning",
      execution_tier: "dedicated-always",
      updated_at: LONG_AGO,
    })
    .returning();
  return row.id;
}

async function seedInFlightJob(
  organizationId: string,
  agentId: string,
  type: string,
): Promise<void> {
  await dbWrite.insert(jobs).values({
    organization_id: organizationId,
    agent_id: agentId,
    type: type as never,
    status: "in_progress",
    data: {},
  });
}

async function statusOf(agentId: string): Promise<string> {
  const row = await repo.findById(agentId);
  if (!row) throw new Error(`agent ${agentId} vanished`);
  return row.status;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[agent-sandboxes-stuck-provisioning-repo.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite fails — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
    );
    return;
  }
  try {
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      // `jobs` carries FKs to these; pushSchema needs them or the DDL fails.
      apiKeys,
      usageRecords,
      generations,
      jobs,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[agent-sandboxes-stuck-provisioning-repo.test] PGlite/pushSchema unavailable — cannot drive AgentSandboxesRepository against a real DB. Failing all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

beforeEach(() => {
  if (!pgliteReady) throw new Error("PGlite harness unavailable");
});

describe("stuck-provisioning sweeper vs in-flight cold boots (#17215)", () => {
  // Every type here reaches `provision()`, which is what parks the row in
  // `provisioning`. `agent_wake` / `agent_resume` are the two the sweeper used
  // to miss, so they are the regression; the other two are the guard that the
  // widening did not lose what already worked.
  for (const jobType of ["agent_wake", "agent_resume", "agent_provision", "agent_restart"]) {
    test(`does not error a provisioning row owned by an in-flight ${jobType}`, async () => {
      const { organizationId, userId } = await seedOrgAndUser();
      const agentId = await seedProvisioningAgent(organizationId, userId);
      await seedInFlightJob(organizationId, agentId, jobType);

      const swept = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);

      expect(swept.map((row) => row.agentId)).not.toContain(agentId);
      expect(await statusOf(agentId)).toBe("provisioning");
    });
  }

  test("still errors a provisioning row with no owning job at all", async () => {
    // The sweeper's actual purpose must survive the widening: a row whose job
    // vanished is genuinely abandoned and has to be reclaimed.
    const { organizationId, userId } = await seedOrgAndUser();
    const agentId = await seedProvisioningAgent(organizationId, userId);

    const swept = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);

    expect(swept.map((row) => row.agentId)).toContain(agentId);
    expect(await statusOf(agentId)).toBe("error");
  });

  test("still errors a provisioning row whose owning job already settled", async () => {
    const { organizationId, userId } = await seedOrgAndUser();
    const agentId = await seedProvisioningAgent(organizationId, userId);
    await dbWrite.insert(jobs).values({
      organization_id: organizationId,
      agent_id: agentId,
      type: "agent_wake" as never,
      status: "failed",
      data: {},
    });

    const swept = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);

    expect(swept.map((row) => row.agentId)).toContain(agentId);
    expect(await statusOf(agentId)).toBe("error");
  });
});
