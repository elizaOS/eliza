import {
  createCloudAgent,
  getPersistedDockerImage,
  pollSandboxStatus,
  startAgentProvisioning,
  tickProvisioning,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

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

  test("API provisions a custom image through the full agent lifecycle", async ({
    stack,
    seededUser,
  }) => {
    const dockerImage = "ghcr.io/elizaos/eliza:e2e-custom";
    const sandboxId = await createCloudAgent(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      "e2e-api-custom-image",
      { dockerImage },
    );

    expect(
      await getPersistedDockerImage(sandboxId, seededUser.organizationId),
    ).toBe(dockerImage);

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

    expect(
      await getPersistedDockerImage(sandboxId, seededUser.organizationId),
    ).toBe(dockerImage);
  });
});
