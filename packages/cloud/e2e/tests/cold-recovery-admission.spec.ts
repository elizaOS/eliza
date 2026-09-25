/** Real SIWE/Worker/PGlite admission; no compute worker or provider execution. */
import { dbWrite } from "@elizaos/cloud-shared/db/helpers";
import { agentSandboxesRepository } from "@elizaos/cloud-shared/db/repositories/agent-sandboxes";
import { jobsRepository } from "@elizaos/cloud-shared/db/repositories/jobs";
import { agentComputeStopIntents } from "@elizaos/cloud-shared/db/schemas/agent-compute-stop-intents";
import { SocketRedis } from "@elizaos/cloud-shared/lib/cache/socket-redis";
import { publishProvisioningWorkerHeartbeat } from "@elizaos/cloud-shared/lib/services/provisioning-worker-health";
import { createCloudAgent } from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

// Optional isolated Redis exercises the required heartbeat gate across processes.
// The default mock-backed lane still verifies real queue admission, but does not
// claim daemon liveness: its in-memory Redis belongs to the Worker process.
const redisUrl = process.env.E2E_COLD_RECOVERY_REDIS_URL;
if (redisUrl && !/^redis:\/\/127\.0\.0\.1:\d+$/.test(redisUrl))
  throw new Error("Cold-recovery Redis fixture must be isolated loopback");
test.use({
  stackOptions: {
    frontend: false,
    env: {
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
      REQUIRE_PROVISIONING_WORKER: redisUrl ? "true" : "false",
      MOCK_REDIS: redisUrl ? "0" : "1",
      REDIS_URL: redisUrl ?? "",
    },
  },
});

test("billing cold recovery creates and reuses a tenant-bound wake job", async ({
  stack,
  seededUser,
}) => {
  if (redisUrl) {
    const redis = new SocketRedis({ url: redisUrl });
    try {
      expect(await publishProvisioningWorkerHeartbeat(redis)).toBe(true);
    } finally {
      await redis.close();
    }
  }
  const agentId = await createCloudAgent(
    { apiUrl: stack.urls.api },
    seededUser.apiKey,
    "cold-billing-admission",
    { alwaysOn: true, autoProvision: false },
  );
  await agentSandboxesRepository.update(agentId, {
    status: "sleeping",
    sandbox_id: null,
    node_id: null,
    container_name: null,
    bridge_url: null,
    health_url: null,
  });
  const sandbox = await agentSandboxesRepository.findByIdAndOrg(
    agentId,
    seededUser.organizationId,
  );
  expect(sandbox?.status).toBe("sleeping");
  if (!sandbox) throw new Error("Missing fixture sandbox");
  await dbWrite.insert(agentComputeStopIntents).values({
    agent_id: agentId,
    organization_id: seededUser.organizationId,
    lifecycle_revision: sandbox.lifecycle_revision,
    authorization: "billing_request",
    status: "provider_confirmed",
    provider_confirmed_at: new Date(),
  });
  const recover = () =>
    fetch(`${stack.urls.api}/api/v1/eliza/agents/${agentId}/pairing-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${seededUser.apiKey}` },
    });
  const first = await recover();
  const firstBody = await first.json();
  expect(first.status, JSON.stringify(firstBody)).toBe(202);
  expect(firstBody).toMatchObject({
    success: true,
    data: { status: "starting", alreadyInProgress: false },
  });
  expect(typeof firstBody.data.jobId).toBe("string");
  const admitted = await jobsRepository.findByIdAndOrg(
    firstBody.data.jobId,
    seededUser.organizationId,
  );
  expect(admitted).toMatchObject({
    type: "agent_wake",
    organization_id: seededUser.organizationId,
    agent_id: agentId,
    status: "pending",
    data: {
      agentId,
      organizationId: seededUser.organizationId,
      userId: seededUser.userId,
    },
  });
  expect(admitted?.data.forceFreshBoot).toBeUndefined();
  const second = await recover();
  const secondBody = await second.json();
  expect(second.status, JSON.stringify(secondBody)).toBe(202);
  expect(secondBody).toMatchObject({
    data: { jobId: firstBody.data.jobId, alreadyInProgress: true },
  });
  expect(
    await jobsRepository.findLatestAgentLifecycleJob({
      type: "agent_provision",
      organizationId: seededUser.organizationId,
      agentId,
    }),
  ).toBeNull();
  process.stdout.write(
    `[cold-recovery admission] requiredHeartbeat=${Boolean(redisUrl)} type=${admitted?.type} job=${admitted?.id} duplicate=${secondBody.data.jobId}\n`,
  );
});
