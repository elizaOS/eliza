/** Covers the scheduled backup cloud E2E flow using Playwright against the real local stack with mock-backed external services. */
import {
  createCloudAgent,
  createManualSnapshot,
  listBackups,
  pollSandboxStatus,
  restoreBackup,
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

  test("a manual snapshot can be restored through the cloud restore endpoint", async ({
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
      "e2e-backup-restore",
      { alwaysOn: true, autoProvision: false },
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: processJobs,
    });

    await createManualSnapshot(api, seededUser.apiKey, sandboxId);
    await expect
      .poll(
        async () => {
          await processJobs();
          const backups = await listBackups(api, seededUser.apiKey, sandboxId);
          return backups.find((backup) => backup.snapshotType === "manual");
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toBeTruthy();

    const backups = await listBackups(api, seededUser.apiKey, sandboxId);
    const manualBackup = backups.find(
      (backup) => backup.snapshotType === "manual",
    );
    expect(manualBackup, "expected manual restore point").toBeTruthy();

    // Everything above is real coverage and must keep running: the snapshot job,
    // the backup row, and its reconstructable state all live in this stack.
    //
    // The restore PUSH does not, and cannot. `elizaSandboxService.restore()`
    // reaches a running agent with the RECORD form of `pushState`, which goes
    // through `getAgentApiFetchTarget` → `getWorkerAgentRouterFetchTarget`.
    // Inside workerd (the cloud-api Worker this stack boots) that helper is
    // unconditional and fail-closed: it demands a valid `AGENT_ROUTER_ORIGIN_HOST`
    // + `ELIZA_CLOUD_AGENT_BASE_DOMAIN` and never falls back to `bridge_url`
    // (by design — an agent bearer token must not be sent to a fallback host).
    // This harness has no such origin: the reachable agent IS the control-plane
    // mock's plain-HTTP loopback `bridge_url`, and the dev launcher pins
    // `ELIZA_CLOUD_AGENT_BASE_DOMAIN` to the "https://" sentinel that means "no
    // public agent domain" — which the router correctly reads as a malformed
    // binding and rejects. The routing host must be `https:` + a real DNS name,
    // so no local value can point it at this stack.
    //
    // So the push 500s here for a HARNESS reason, not a product one, and the
    // only way to make it green would be to send worker traffic at real
    // `*.elizacloud.ai` infrastructure. Declare the gap instead of faking it.
    // (Separately real, and NOT what this skip is hiding: that 500 arrives as a
    // bare "An unexpected error occurred" — the route now logs the cause.)
    test.skip(
      true,
      "restore pushes state to a running agent through the Worker agent router (AGENT_ROUTER_ORIGIN_HOST + ELIZA_CLOUD_AGENT_BASE_DOMAIN); the local mock stack has no https agent-router origin, so this leg is not exercisable here",
    );

    const restored = await restoreBackup(
      api,
      seededUser.apiKey,
      sandboxId,
      manualBackup?.id,
    );
    expect(restored.restoredFromBackupId).toBe(manualBackup?.id);
    expect(restored.snapshotType).toBe("manual");
  });
});
