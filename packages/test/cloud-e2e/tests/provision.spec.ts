import {
  createCloudAgent,
  pollSandboxStatus,
  startAgentProvisioning,
  tickProvisioning,
} from "../src/helpers/provisioning";
import { test } from "../src/helpers/test-fixtures";

test.describe("provision", () => {
  test("provisioning job transitions to running via control-plane tick", async ({
    stack,
    seededUser,
  }) => {
    // Drive provisioning entirely via API — the wizard surface is rich UI and
    // its CloudSetupSession flow varies build-to-build. The end-state contract
    // is what matters: a provisioning job exists, the cron tick processes it,
    // the sandbox ends `running`.
    const sandboxId = await createCloudAgent(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      "e2e-provision-agent",
    );
    await startAgentProvisioning(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      sandboxId,
    );

    await pollSandboxStatus(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      sandboxId,
      "running",
      {
        timeoutMs: 30_000,
        intervalMs: 250,
        onTick: async () => {
          await tickProvisioning({ apiUrl: stack.urls.api });
        },
      },
    );
  });
});
