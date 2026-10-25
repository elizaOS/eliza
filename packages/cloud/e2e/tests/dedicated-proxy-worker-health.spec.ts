/**
 * Verifies the dedicated hostname's unavailable-worker response through the
 * local Wrangler Worker, owner authentication, and PGlite persistence.
 */
import { request as httpRequest } from "node:http";
import { agentSandboxesRepository } from "@elizaos/cloud-shared/db/repositories/agent-sandboxes";
import { jobsRepository } from "@elizaos/cloud-shared/db/repositories/jobs";
import { createCloudAgent } from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

test.use({
  stackOptions: {
    frontend: false,
    env: {
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
      REQUIRE_PROVISIONING_WORKER: "true",
    },
  },
});

test("stopped dedicated agent reports worker outage without enqueueing a resume", async ({
  stack,
  seededUser,
}) => {
  const agentId = await createCloudAgent(
    { apiUrl: stack.urls.api },
    seededUser.apiKey,
    "dedicated-worker-outage",
    { alwaysOn: true, autoProvision: false },
  );
  await agentSandboxesRepository.update(agentId, { status: "stopped" });
  const sandbox = await agentSandboxesRepository.findByIdAndOrg(
    agentId,
    seededUser.organizationId,
  );
  expect(sandbox?.status).toBe("stopped");
  expect(sandbox?.execution_tier).not.toBe("shared");

  const jobFilters = {
    type: "agent_provision" as const,
    organizationId: seededUser.organizationId,
    agentId,
  };
  const previousJob =
    await jobsRepository.findLatestAgentLifecycleJob(jobFilters);
  const apiPort = new URL(stack.urls.api).port;
  const agentHost = `${agentId}.cloud.eliza.app`;
  const result = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        `http://${agentHost}:${apiPort}/api/status`,
        {
          headers: {
            Authorization: `Bearer ${seededUser.apiKey}`,
            Origin: "https://cloud.eliza.app",
          },
          lookup: (_hostname, options, callback) => {
            // Node's dual-stack connector requests an address array when `all` is set.
            if (options.all) {
              callback(null, [{ address: "127.0.0.1", family: 4 }]);
            } else {
              callback(null, "127.0.0.1", 4);
            }
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    },
  );

  const nextJob = await jobsRepository.findLatestAgentLifecycleJob(jobFilters);
  process.stdout.write(
    `[dedicated-proxy e2e] status=${result.status} body=${result.body} previousJob=${previousJob?.id ?? "none"} nextJob=${nextJob?.id ?? "none"}\n`,
  );
  expect(result.status).toBe(503);
  expect(JSON.parse(result.body)).toMatchObject({
    success: false,
    code: "PROVISIONING_WORKER_UNHEALTHY",
    retryable: true,
  });
  expect(nextJob).toEqual(previousJob);
});
