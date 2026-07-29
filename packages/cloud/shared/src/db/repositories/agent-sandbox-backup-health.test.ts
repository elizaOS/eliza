/**
 * Exercises backup reservation, lease recovery, and image-fenced attempt state
 * against real in-process PGlite DDL; no repository or transaction is mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import {
  readBackupFleetHealthConfig,
  runAgentBackupFleetHealthCycle,
} from "../../lib/services/agent-backup-fleet-health";
import type { DaemonHealthAlert } from "../../lib/services/provisioning-worker-health-monitor";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { sqlRows } from "../execute-helpers";
import { agentBackupFleetHealthState } from "../schemas/agent-backup-fleet-health-state";
import { agentSandboxBackupHealth } from "../schemas/agent-sandbox-backup-health";
import {
  type AgentBackupStateData,
  agentSandboxBackups,
  agentSandboxes,
} from "../schemas/agent-sandboxes";
import { apiKeys } from "../schemas/api-keys";
import { generations } from "../schemas/generations";
import { jobs } from "../schemas/jobs";
import { organizations } from "../schemas/organizations";
import { usageRecords } from "../schemas/usage-records";
import { userCharacters } from "../schemas/user-characters";
import { users } from "../schemas/users";
import {
  agentSandboxBackupHealthRepository,
  DEFAULT_BACKUP_SWEEP_LEASE_MS,
} from "./agent-sandbox-backup-health";
import { agentSandboxesRepository } from "./agent-sandboxes";

const TEST_TIMEOUT_MS = 60_000;
let pgliteReady = true;
let sequence = 0;
let databaseNow = new Date(0);

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

async function seedSandbox(
  params: {
    imageDigest?: string | null;
    lastBackupAt?: Date | null;
    bridgeUrl?: string | null;
  } = {},
): Promise<{ id: string; organizationId: string; userId: string }> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Backup Health Org", slug: unique("backup-health-org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: unique("backup-health-user"),
      organization_id: organization.id,
    })
    .returning();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organization.id,
      user_id: user.id,
      agent_name: unique("backup-health-agent"),
      status: "running",
      execution_tier: "dedicated-always",
      bridge_url: params.bridgeUrl === undefined ? "http://10.42.0.5:8080" : params.bridgeUrl,
      image_digest:
        params.imageDigest === undefined ? `sha256:${unique("image")}` : params.imageDigest,
      environment_vars: { ELIZA_AGENT_LOCAL_STATE: "1" },
      last_backup_at: params.lastBackupAt ?? null,
      created_at: new Date(databaseNow.getTime() - 24 * 60 * 60_000),
    })
    .returning();
  return {
    id: sandbox.id,
    organizationId: organization.id,
    userId: user.id,
  };
}

async function readDatabaseNow(): Promise<Date> {
  const [clock] = await sqlRows<{ now: Date | string }>(
    dbWrite,
    sql`SELECT clock_timestamp() AS now`,
  );
  if (!clock) throw new Error("PGlite clock query returned no row");
  return clock.now instanceof Date ? clock.now : new Date(clock.now);
}

async function seedSnapshotExecution(
  sandbox: { id: string; organizationId: string; userId: string },
  startedAt: Date = databaseNow,
): Promise<{ jobId: string; jobStartedAt: Date }> {
  const [job] = await dbWrite
    .insert(jobs)
    .values({
      type: "agent_snapshot",
      status: "in_progress",
      data: {
        agentId: sandbox.id,
        organizationId: sandbox.organizationId,
        userId: sandbox.userId,
        snapshotType: "auto",
      },
      data_storage: "inline",
      agent_id: sandbox.id,
      organization_id: sandbox.organizationId,
      user_id: sandbox.userId,
      started_at: startedAt,
    })
    .returning();
  return { jobId: job.id, jobStartedAt: startedAt };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  const schema = {
    organizations,
    users,
    userCharacters,
    apiKeys,
    usageRecords,
    generations,
    agentSandboxes,
    agentSandboxBackups,
    agentBackupFleetHealthState,
    agentSandboxBackupHealth,
    jobs,
  };
  const { apply } = await pushSchema(schema, dbWrite);
  await apply();
}, TEST_TIMEOUT_MS);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(agentBackupFleetHealthState);
  databaseNow = await readDatabaseNow();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent sandbox backup-health reservation", () => {
  test("overlapping sweeps reserve distinct rows under SKIP LOCKED", async () => {
    const first = await seedSandbox();
    const second = await seedSandbox();

    const [left, right] = await Promise.all([
      agentSandboxBackupHealthRepository.reserveDueBackups({
        minIntervalMs: 6 * 60 * 60_000,
        maxAgents: 1,
      }),
      agentSandboxBackupHealthRepository.reserveDueBackups({
        minIntervalMs: 6 * 60 * 60_000,
        maxAgents: 1,
      }),
    ]);

    expect(left.dueTotal).toBe(2);
    expect(right.dueTotal).toBe(2);
    const selected = [left.candidates[0]?.id, right.candidates[0]?.id].filter(
      (id): id is string => id !== undefined,
    );
    expect(new Set(selected)).toEqual(new Set([first.id, second.id]));
  });

  test("an unexpired lease blocks re-selection and an expired lease recovers", async () => {
    const sandbox = await seedSandbox();
    const first = await agentSandboxBackupHealthRepository.reserveDueBackups({
      minIntervalMs: 6 * 60 * 60_000,
      maxAgents: 1,
    });
    expect(first.candidates[0]?.id).toBe(sandbox.id);

    const stillLeased = await agentSandboxBackupHealthRepository.reserveDueBackups({
      minIntervalMs: 6 * 60 * 60_000,
      maxAgents: 1,
    });
    expect(stillLeased.candidates).toHaveLength(0);

    const [leased] = await dbWrite
      .select()
      .from(agentSandboxBackupHealth)
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    expect(leased.lease_expires_at).not.toBeNull();
    expect(
      Math.abs(
        (leased.lease_expires_at?.getTime() ?? 0) -
          first.asOf.getTime() -
          DEFAULT_BACKUP_SWEEP_LEASE_MS,
      ),
    ).toBeLessThan(1_000);
    await dbWrite
      .update(agentSandboxBackupHealth)
      .set({ lease_expires_at: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    const recovered = await agentSandboxBackupHealthRepository.reserveDueBackups({
      minIntervalMs: 6 * 60 * 60_000,
      maxAgents: 1,
    });
    expect(recovered.candidates[0]?.id).toBe(sandbox.id);
    expect(recovered.candidates[0]?.leaseToken).not.toBe(first.candidates[0]?.leaseToken);
  });

  test("active automatic jobs are measured as reused and excluded from selection", async () => {
    const sandbox = await seedSandbox();
    await dbWrite.insert(jobs).values({
      type: "agent_snapshot",
      status: "pending",
      data: {
        agentId: sandbox.id,
        organizationId: sandbox.organizationId,
        userId: sandbox.userId,
        snapshotType: "auto",
      },
      data_storage: "inline",
      agent_id: sandbox.id,
      organization_id: sandbox.organizationId,
      user_id: sandbox.userId,
    });

    const reservation = await agentSandboxBackupHealthRepository.reserveDueBackups({
      minIntervalMs: 6 * 60 * 60_000,
      maxAgents: 1,
    });

    expect(reservation.dueTotal).toBe(1);
    expect(reservation.activeTotal).toBe(1);
    expect(reservation.candidates).toHaveLength(0);
  });

  test("an exact image change invalidates unsupported and makes the row reachable", async () => {
    const sandbox = await seedSandbox({ imageDigest: "sha256:old" });
    await dbWrite.insert(agentSandboxBackupHealth).values({
      sandbox_record_id: sandbox.id,
      image_identity: "sha256:old",
      capability: "unsupported",
    });

    const oldImage = await agentSandboxBackupHealthRepository.reserveDueBackups({
      minIntervalMs: 6 * 60 * 60_000,
      maxAgents: 1,
    });
    expect(oldImage.unsupportedTotal).toBe(1);
    expect(oldImage.candidates).toHaveLength(0);

    await dbWrite
      .update(agentSandboxes)
      .set({ image_digest: "sha256:new" })
      .where(eq(agentSandboxes.id, sandbox.id));
    const newImage = await agentSandboxBackupHealthRepository.reserveDueBackups({
      minIntervalMs: 6 * 60 * 60_000,
      maxAgents: 1,
    });
    expect(newImage.unsupportedTotal).toBe(0);
    expect(newImage.candidates[0]?.id).toBe(sandbox.id);

    const [health] = await dbWrite
      .select()
      .from(agentSandboxBackupHealth)
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    expect(health?.image_identity).toBe("sha256:new");
    expect(health?.capability).toBe("unknown");
  });

  test("an image change clears a live lease and stays due despite a recent backup", async () => {
    const sandbox = await seedSandbox({
      imageDigest: "sha256:lease-old",
      lastBackupAt: databaseNow,
    });
    await dbWrite.insert(agentSandboxBackupHealth).values({
      sandbox_record_id: sandbox.id,
      image_identity: "sha256:lease-old",
      capability: "supported",
      last_success_at: databaseNow,
      lease_token: "e5d14094-0ff0-4112-89bf-eab580f771c9",
      lease_expires_at: new Date(databaseNow.getTime() + 60 * 60_000),
    });
    await dbWrite
      .update(agentSandboxes)
      .set({ image_digest: "sha256:lease-new" })
      .where(eq(agentSandboxes.id, sandbox.id));

    const reservation = await agentSandboxBackupHealthRepository.reserveDueBackups({
      minIntervalMs: 6 * 60 * 60_000,
      maxAgents: 1,
    });

    expect(reservation.candidates[0]?.id).toBe(sandbox.id);
    const [changed] = await dbWrite
      .select()
      .from(agentSandboxBackupHealth)
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    expect(changed?.backup_required).toBe(true);
    expect(changed?.last_outcome).toBe("image_changed");

    const execution = await seedSnapshotExecution(sandbox);
    const attempt = await agentSandboxBackupHealthRepository.startAttempt(sandbox.id, execution);
    await agentSandboxBackupHealthRepository.recordAttemptOutcome({
      attempt,
      outcome: "success",
    });
    const [healthy] = await dbWrite
      .select()
      .from(agentSandboxBackupHealth)
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    expect(healthy?.backup_required).toBe(false);
  });
});

describe("agent sandbox backup-health attempts", () => {
  test("failure stamps backoff without fabricating a successful backup", async () => {
    const sandbox = await seedSandbox({ imageDigest: "sha256:attempt" });
    const execution = await seedSnapshotExecution(sandbox);
    const attempt = await agentSandboxBackupHealthRepository.startAttempt(sandbox.id, execution);
    const result = await agentSandboxBackupHealthRepository.recordAttemptOutcome({
      attempt,
      outcome: "failed",
      error: "bridge timed out",
    });

    expect(result).toEqual({ recorded: true, imageChanged: false });
    const [agent] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    const [health] = await dbWrite
      .select()
      .from(agentSandboxBackupHealth)
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    expect(agent?.last_backup_at).toBeNull();
    expect(health?.last_success_at).toBeNull();
    expect(health?.consecutive_failures).toBe(1);
    expect(health?.next_attempt_at).not.toBeNull();
  });

  test("a digest change during an attempt cannot mark the new image unsupported", async () => {
    const sandbox = await seedSandbox({ imageDigest: "sha256:attempt-old" });
    const execution = await seedSnapshotExecution(sandbox);
    const attempt = await agentSandboxBackupHealthRepository.startAttempt(sandbox.id, execution);
    await dbWrite
      .update(agentSandboxes)
      .set({ image_digest: "sha256:attempt-new" })
      .where(eq(agentSandboxes.id, sandbox.id));

    const result = await agentSandboxBackupHealthRepository.recordAttemptOutcome({
      attempt,
      outcome: "unsupported",
      error: "snapshot endpoint unsupported",
    });

    expect(result).toEqual({ recorded: true, imageChanged: true });
    const [health] = await dbWrite
      .select()
      .from(agentSandboxBackupHealth)
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    expect(health?.image_identity).toBe("sha256:attempt-new");
    expect(health?.capability).toBe("unknown");
    expect(health?.last_outcome).toBe("image_changed");
    expect(health?.backup_required).toBe(true);
    expect(health?.last_success_at).toBeNull();
  });

  test("a live attempt rejects overlap and an expired attempt can be replaced", async () => {
    const sandbox = await seedSandbox({ imageDigest: "sha256:attempt-fence" });
    const fastWorkerStart = new Date("2100-01-01T00:00:00.000Z");
    const firstExecution = await seedSnapshotExecution(sandbox, fastWorkerStart);
    const first = await agentSandboxBackupHealthRepository.startAttempt(sandbox.id, firstExecution);
    const secondExecution = await seedSnapshotExecution(sandbox);

    await expect(
      agentSandboxBackupHealthRepository.startAttempt(sandbox.id, secondExecution),
    ).rejects.toMatchObject({ code: "AGENT_BACKUP_HEALTH_ATTEMPT_ACTIVE" });
    const [live] = await dbWrite
      .select()
      .from(agentSandboxBackupHealth)
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    expect(live?.attempt_token).toBe(first.attemptToken);
    expect(
      Math.abs((live?.last_attempt_started_at?.getTime() ?? 0) - databaseNow.getTime()),
    ).toBeLessThan(5_000);

    await dbWrite
      .update(agentSandboxBackupHealth)
      .set({ last_attempt_started_at: sql`clock_timestamp() - interval '11 minutes'` })
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    const replacement = await agentSandboxBackupHealthRepository.startAttempt(
      sandbox.id,
      secondExecution,
    );
    expect(replacement.attemptToken).not.toBe(first.attemptToken);

    const staleOutcome = await agentSandboxBackupHealthRepository.recordAttemptOutcome({
      attempt: first,
      outcome: "failed",
      error: "late stale delivery",
    });
    expect(staleOutcome).toEqual({ recorded: false, imageChanged: false });
  });

  test("a reclaimed job claim rejects the superseded execution's late outcome", async () => {
    const sandbox = await seedSandbox({ imageDigest: "sha256:job-fence" });
    const execution = await seedSnapshotExecution(sandbox);
    const attempt = await agentSandboxBackupHealthRepository.startAttempt(sandbox.id, execution);
    await dbWrite
      .update(jobs)
      .set({ started_at: new Date(execution.jobStartedAt.getTime() + 1_000) })
      .where(eq(jobs.id, execution.jobId));

    const staleOutcome = await agentSandboxBackupHealthRepository.recordAttemptOutcome({
      attempt,
      outcome: "success",
    });

    expect(staleOutcome).toEqual({ recorded: false, imageChanged: false });
    const [health] = await dbWrite
      .select()
      .from(agentSandboxBackupHealth)
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    expect(health?.last_outcome).toBe("in_progress");
    expect(health?.last_success_at).toBeNull();
  });

  test("generation change marks immediate backup debt without advancing success", async () => {
    const sandbox = await seedSandbox({ imageDigest: "sha256:generation" });
    const execution = await seedSnapshotExecution(sandbox);
    const attempt = await agentSandboxBackupHealthRepository.startAttempt(sandbox.id, execution);
    await agentSandboxBackupHealthRepository.recordAttemptOutcome({
      attempt,
      outcome: "generation_changed",
      error: "runtime locator changed",
    });

    const [health] = await dbWrite
      .select()
      .from(agentSandboxBackupHealth)
      .where(eq(agentSandboxBackupHealth.sandbox_record_id, sandbox.id));
    expect(health).toMatchObject({
      last_outcome: "generation_changed",
      backup_required: true,
      last_success_at: null,
      next_attempt_at: null,
      consecutive_failures: 0,
    });
  });

  test("old-generation backup persistence cannot mark the current image fresh", async () => {
    const sandbox = await seedSandbox({ imageDigest: "sha256:persist-old" });
    const [observed] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    if (!observed) throw new Error("seeded sandbox was not found");
    await dbWrite
      .update(agentSandboxes)
      .set({
        image_digest: "sha256:persist-new",
        environment_revision: observed.environment_revision + 1,
      })
      .where(eq(agentSandboxes.id, sandbox.id));
    const state: AgentBackupStateData = {
      memories: [{ role: "user", text: "old generation", timestamp: 1 }],
      config: { generation: "old" },
      workspaceFiles: {},
    };

    const persisted = await agentSandboxesRepository.createBackupForObservedGeneration(
      {
        sandbox_record_id: sandbox.id,
        snapshot_type: "auto",
        state_data: state,
        size_bytes: 128,
        backup_kind: "full",
      },
      {
        organizationId: observed.organization_id,
        environmentRevision: observed.environment_revision,
        sandboxId: observed.sandbox_id,
        nodeId: observed.node_id,
        containerName: observed.container_name,
        imageDigest: observed.image_digest,
      },
    );

    expect(persisted.generationMatched).toBe(false);
    expect(persisted.canonicalBackupAt).toBeNull();
    const [current] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(current?.image_digest).toBe("sha256:persist-new");
    expect(current?.last_backup_at).toBeNull();
    const stored = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, persisted.backup.id));
    expect(stored).toHaveLength(1);
  });

  test("unavailable attempts count toward repeated-failure health", async () => {
    const sandbox = await seedSandbox({ imageDigest: "sha256:unavailable" });
    for (let attemptNumber = 0; attemptNumber < 3; attemptNumber += 1) {
      const execution = await seedSnapshotExecution(
        sandbox,
        new Date(databaseNow.getTime() + attemptNumber),
      );
      const attempt = await agentSandboxBackupHealthRepository.startAttempt(sandbox.id, execution);
      await agentSandboxBackupHealthRepository.recordAttemptOutcome({
        attempt,
        outcome: "unavailable",
        error: "Sandbox is not running",
      });
    }

    const snapshot = await agentSandboxBackupHealthRepository.readFleetSnapshot({
      targetIntervalMs: 6 * 60 * 60_000,
      repeatedFailureThreshold: 3,
      problemLimit: 10,
    });
    expect(snapshot.repeatedFailures).toBe(1);
    expect(snapshot.problems[0]?.consecutiveFailures).toBe(3);
  });
});

describe("managed backup fleet health", () => {
  const config = {
    targetIntervalMs: 6 * 60 * 60_000,
    repeatedFailureThreshold: 3,
    backlogAlertThreshold: 10,
    problemLimit: 20,
  };

  test("lane disablement is one durable global incident, not one alert per agent", async () => {
    await seedSandbox({ lastBackupAt: databaseNow });
    await seedSandbox({ lastBackupAt: databaseNow });
    const alerts: DaemonHealthAlert[] = [];
    const run = () =>
      runAgentBackupFleetHealthCycle({
        config,
        laneEnabled: false,
        alert: (entry) => {
          alerts.push(entry);
        },
      });

    const first = await run();
    const second = await run();

    expect(first).toMatchObject({
      laneEnabled: false,
      healthy: false,
      total: 2,
      absent: 0,
      newAlerts: 1,
    });
    expect(second.newAlerts).toBe(0);
    expect(alerts).toHaveLength(1);

    const recovered = await runAgentBackupFleetHealthCycle({
      config,
      laneEnabled: true,
      alert: (entry) => {
        alerts.push(entry);
      },
    });
    expect(recovered.healthy).toBe(true);
  });

  test("never-backed-up agents report their real coverage age and deduplicate", async () => {
    const sandbox = await seedSandbox();
    const alerts: DaemonHealthAlert[] = [];
    const first = await runAgentBackupFleetHealthCycle({
      config,
      laneEnabled: true,
      alert: (entry) => {
        alerts.push(entry);
      },
    });
    const second = await runAgentBackupFleetHealthCycle({
      config,
      laneEnabled: true,
      alert: (entry) => {
        alerts.push(entry);
      },
    });

    expect(first.absent).toBe(1);
    expect(first.oldestBackupAgeMs).toBeGreaterThanOrEqual(24 * 60 * 60_000);
    expect(first.oldestBackupAgeMs).toBeLessThan(24 * 60 * 60_000 + 5_000);
    expect(first.newAlerts).toBe(1);
    expect(second.newAlerts).toBe(0);
    expect(alerts).toHaveLength(1);

    await dbWrite
      .update(agentSandboxes)
      .set({ last_backup_at: sql`clock_timestamp()` })
      .where(eq(agentSandboxes.id, sandbox.id));
    const recovered = await runAgentBackupFleetHealthCycle({
      config,
      laneEnabled: true,
      alert: (entry) => {
        alerts.push(entry);
      },
    });
    expect(recovered.healthy).toBe(true);
  });

  test("failed alert delivery releases the durable claim for retry", async () => {
    await seedSandbox({ lastBackupAt: databaseNow });
    await expect(
      runAgentBackupFleetHealthCycle({
        config,
        laneEnabled: false,
        alert: () => {
          throw new Error("ops transport failed");
        },
      }),
    ).rejects.toThrow("Managed backup fleet alert delivery failed");

    const retried = await runAgentBackupFleetHealthCycle({
      config,
      laneEnabled: false,
      alert: () => undefined,
    });
    expect(retried.newAlerts).toBe(1);
  });

  test("present invalid numeric configuration fails fast", () => {
    expect(() =>
      readBackupFleetHealthConfig({
        AGENT_BACKUP_FAILURE_ALERT_THRESHOLD: "three",
      }),
    ).toThrow("AGENT_BACKUP_FAILURE_ALERT_THRESHOLD must be a positive integer");
  });
});
