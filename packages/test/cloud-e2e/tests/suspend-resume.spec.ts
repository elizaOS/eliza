import {
  agentLifecycleAction,
  createCloudAgent,
  pollSandboxStatus,
  startAgentProvisioning,
  tickProvisioning,
} from "../src/helpers/provisioning";
import { test } from "../src/helpers/test-fixtures";

const onTick = (apiUrl: string) => async () => {
  await tickProvisioning({ apiUrl });
};

test.describe("suspend / resume", () => {
  test("running agent suspends to stopped then resumes to running", async ({
    stack,
    seededUser,
  }) => {
    const api = { apiUrl: stack.urls.api };

    const sandboxId = await createCloudAgent(
      api,
      seededUser.apiKey,
      "e2e-suspend-resume",
    );
    await startAgentProvisioning(api, seededUser.apiKey, sandboxId);
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });

    await agentLifecycleAction(
      api,
      seededUser.apiKey,
      sandboxId,
      "suspend",
      [202],
    );
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "stopped", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });

    await agentLifecycleAction(
      api,
      seededUser.apiKey,
      sandboxId,
      "resume",
      [202],
    );
    await pollSandboxStatus(api, seededUser.apiKey, sandboxId, "running", {
      timeoutMs: 30_000,
      onTick: onTick(stack.urls.api),
    });
  });
});
