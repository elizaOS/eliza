import {
  createCloudAgent,
  listBackups,
  pollSandboxStatus,
  runScheduledBackups,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("scheduled backups", () => {
  test("the cron enqueues an auto-snapshot for a running agent and it produces a backup", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-scheduled-backup",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });

    const sweep = await runScheduledBackups(api, { intervalMs: 0 });
    expect(
      sweep.enqueued,
      "scheduled sweep should enqueue at least the new agent",
    ).toBeGreaterThanOrEqual(1);

    await expect
      .poll(
        async () => {
          await processJobs();
          const backups = await listBackups(api, seededUser.apiKey, sandboxId);
          return backups.length;
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toBeGreaterThanOrEqual(1);

    const backups = await listBackups(api, seededUser.apiKey, sandboxId);
    expect(backups.some((b) => b.snapshotType === "auto")).toBe(true);
  });

  test("the cron skips agents with a recent backup", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };
    const processJobs = async () => {
      const result = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(result.failed, JSON.stringify(result.errors)).toBe(0);
    };

    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-backup-skip",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });

    await runScheduledBackups(api, { intervalMs: 0 });
    await expect
      .poll(
        async () => {
          await processJobs();
          const backups = await listBackups(api, seededUser.apiKey, sandboxId);
          return backups.length;
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toBeGreaterThanOrEqual(1);

    const second = await runScheduledBackups(api, {
      intervalMs: 60 * 60 * 1000,
    });
    expect(second.enqueued).toBe(0);
  });
});
