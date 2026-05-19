import { test, expect } from "../src/helpers/test-fixtures";
import { getSandboxState, tickCleanupStuck } from "../src/helpers/provisioning";

test.describe("stuck-cleanup", () => {
  test("provisioning sandbox without a job transitions to error after timeout", async ({
    stack,
    seededUser,
  }) => {
    // Insert a stuck sandbox directly via cloud-shared repository so we don't
    // depend on the API's create-flow timing. Backdate created_at to be older
    // than the cleanup cutoff (default 10min in the route).
    const { agentSandboxesRepository } = await import(
      "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
    );

    const past = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const sandbox = await agentSandboxesRepository.create({
      organization_id: seededUser.organizationId,
      user_id: seededUser.userId,
      sandbox_id: `stuck-${Date.now()}`,
      status: "provisioning",
      agent_name: "stuck-e2e-agent",
      bridge_url: "http://127.0.0.1:65535",
      health_url: "http://127.0.0.1:65535/health",
      database_status: "provisioning",
      environment_vars: {},
    });

    // Backdate after create so cleanup sees the row as older than the cutoff.
    await agentSandboxesRepository.update(sandbox.id, {
      created_at: past,
      updated_at: past,
    });

    const cleanupRes = await tickCleanupStuck({ apiUrl: stack.urls.api });
    expect([200, 202]).toContain(cleanupRes.status);

    await expect
      .poll(
        async () => {
          const { body } = await getSandboxState(
            { apiUrl: stack.urls.api },
            seededUser.apiKey,
            sandbox.id,
          );
          if (typeof body === "object" && body !== null) {
            const status =
              (body as { status?: string }).status ??
              (body as { data?: { status?: string } }).data?.status;
            return status;
          }
          return undefined;
        },
        { timeout: 15_000, intervals: [250] },
      )
      .toBe("error");
  });
});
