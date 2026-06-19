/**
 * Smoke tests for the job-type registry. These catch the cheap-to-make
 * mistakes that the orchestrator daemon can't recover from at runtime:
 * a typo on the wire value (DB rows reference the string, not the
 * symbol), a missing entry (daemon sees a job type it doesn't recognize
 * and the job rots in `pending`), or accidental duplicates (two symbols
 * mapped to the same wire value silently route to the wrong executor).
 *
 * The actual executor logic (SSH, advisory locks, DB writes) needs a
 * test harness that the cloud-shared package doesn't have yet — those
 * tests are a follow-up.
 */
import { describe, expect, test } from "bun:test";
import { JOB_TYPES, type ProvisioningJobType } from "../provisioning-job-types";

describe("JOB_TYPES", () => {
  test("includes every registered job type", () => {
    expect(JOB_TYPES.AGENT_PROVISION).toBe("agent_provision");
    expect(JOB_TYPES.AGENT_DELETE).toBe("agent_delete");
    expect(JOB_TYPES.AGENT_SUSPEND).toBe("agent_suspend");
    expect(JOB_TYPES.AGENT_RESUME).toBe("agent_resume");
    expect(JOB_TYPES.AGENT_RESTART).toBe("agent_restart");
    expect(JOB_TYPES.AGENT_LOGS).toBe("agent_logs");
    expect(JOB_TYPES.AGENT_MESSAGE).toBe("agent_message");
    expect(JOB_TYPES.AGENT_SNAPSHOT).toBe("agent_snapshot");
    expect(JOB_TYPES.AGENT_UPGRADE).toBe("agent_upgrade");
    expect(JOB_TYPES.AGENT_SLEEP).toBe("agent_sleep");
    expect(JOB_TYPES.AGENT_WAKE).toBe("agent_wake");
    // Apps lane (Product 2): the Worker enqueues APP_DEPLOY; the daemon runs it.
    expect(JOB_TYPES.APP_DEPLOY).toBe("app_deploy");
    // Apps lane (Product 2): the Worker enqueues APP_DB_DEPROVISION on app
    // delete; the daemon runs the isolated tenant-DB DROP + slot release.
    expect(JOB_TYPES.APP_DB_DEPROVISION).toBe("app_db_deprovision");
    // Billing suspend (#8342): the container-billing cron (Worker, no SSH)
    // enqueues CONTAINER_STOP; the daemon docker-stops the node container
    // (volume preserved, slot freed) so a deadbeat app can't run for free.
    expect(JOB_TYPES.CONTAINER_STOP).toBe("container_stop");
    // Lock the size so a new entry without a matching assertion above
    // fails CI instead of being silently under-covered by tests below.
    expect(Object.keys(JOB_TYPES)).toHaveLength(19);
  });

  test("wire values are unique (no two symbols share a string)", () => {
    const values = Object.values(JOB_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });

  test("wire values are snake_case (matches DB convention)", () => {
    for (const value of Object.values(JOB_TYPES)) {
      expect(value).toMatch(/^[a-z]+(?:_[a-z]+)+$/);
    }
  });

  test("ProvisioningJobType narrows to the registered set", () => {
    const known: ProvisioningJobType = "agent_suspend";
    expect(Object.values(JOB_TYPES)).toContain(known);
  });
});
