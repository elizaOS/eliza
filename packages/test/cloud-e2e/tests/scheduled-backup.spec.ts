import {
  createCloudAgent,
  listBackups,
  pollSandboxStatus,
  runScheduledBackups,
  startAgentProvisioning,
  tickProvisioning,
} from "../src/helpers/provisioning";
import { test, expect } from "../src/helpers/test-fixtures";

const onTick = (apiUrl: string) => async () => {
  await tickProvisioning({ apiUrl });
};

test.describe("scheduled backups", () => {
  test("the cron enqueues an auto-snapshot for a running agent and it produces a backup", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };

    const sandboxId = await createCloudAgent(api, seededUser.apiKey, "e2e-scheduled-backup");
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });

    // intervalMs=0 makes every running agent "due" so the sweep is deterministic.
    const sweep = await runScheduledBackups(api, { intervalMs: 0 });
    expect(sweep.enqueued, "scheduled sweep should enqueue at least the new agent").toBeGreaterThanOrEqual(
      1,
    );

    // Drive the snapshot job to completion and confirm a backup landed.
    await expect
      .poll(
        async () => {
          await tickProvisioning({ apiUrl: stack.urls.api });
          const backups = await listBackups(api, seededUser.apiKey, sandboxId);
          return backups.length;
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toBeGreaterThanOrEqual(1);

    const backups = await listBackups(api, seededUser.apiKey, sandboxId);
    expect(backups.some((b) => b.snapshotType === "auto")).toBe(true);
  });

  test("the cron skips agents with a recent backup", async ({ stack, seededUser }) => {
    const api = { apiUrl: stack.urls.api };

    const sandboxId = await createCloudAgent(api, seededUser.apiKey, "e2e-backup-skip");
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });

    // First sweep makes a backup; second sweep with a long interval should find
    // nothing due (the agent was just backed up).
    await runScheduledBackups(api, { intervalMs: 0 });
    await expect
      .poll(
        async () => {
          await tickProvisioning({ apiUrl: stack.urls.api });
          const backups = await listBackups(api, seededUser.apiKey, sandboxId);
          return backups.length;
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toBeGreaterThanOrEqual(1);

    const second = await runScheduledBackups(api, { intervalMs: 60 * 60 * 1000 });
    expect(second.enqueued).toBe(0);
  });
});
