/**
 * Deterministically drives concurrent container POSTs through createApp's
 * generated route, the real container service, HetznerContainersClient,
 * repositories, quota resolver, PGlite transactions, and Docker-node status
 * path. Test configuration bypasses authenticated actor selection and image
 * policy enforcement, and a stateful fake replaces the DockerSSHClient network
 * transport. This is not Workerd, Hetzner Cloud, Docker-daemon, or real-SSH
 * evidence.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import type { AccountBillingSnapshot } from "../../shared/src/types/account-billing-snapshot";

const PREVIOUS_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  ENVIRONMENT: process.env.ENVIRONMENT,
  MOCK_REDIS: process.env.MOCK_REDIS,
  CACHE_ENABLED: process.env.CACHE_ENABLED,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
  CONTAINERS_REGISTRY_TOKEN: process.env.CONTAINERS_REGISTRY_TOKEN,
  ELIZA_APP_IMAGE_REGISTRY_TOKEN: process.env.ELIZA_APP_IMAGE_REGISTRY_TOKEN,
  GHCR_TOKEN: process.env.GHCR_TOKEN,
  CONTAINERS_REGISTRY_TOKEN_FILE: process.env.CONTAINERS_REGISTRY_TOKEN_FILE,
  ELIZA_APP_IMAGE_REGISTRY_TOKEN_FILE:
    process.env.ELIZA_APP_IMAGE_REGISTRY_TOKEN_FILE,
  CONTAINERS_DOCKER_NETWORK: process.env.CONTAINERS_DOCKER_NETWORK,
  AGENT_DOCKER_NETWORK: process.env.AGENT_DOCKER_NETWORK,
};

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.ENVIRONMENT = "test";
process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
delete process.env.CONTAINERS_REGISTRY_TOKEN;
delete process.env.ELIZA_APP_IMAGE_REGISTRY_TOKEN;
delete process.env.GHCR_TOKEN;
delete process.env.CONTAINERS_REGISTRY_TOKEN_FILE;
delete process.env.ELIZA_APP_IMAGE_REGISTRY_TOKEN_FILE;
delete process.env.CONTAINERS_DOCKER_NETWORK;
delete process.env.AGENT_DOCKER_NETWORK;

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const ORGANIZATION_CONFIG_ID = "10000000-0000-4000-8000-000000000003";
const DOCKER_NODE_RECORD_ID = "10000000-0000-4000-8000-000000000004";
const DOCKER_NODE_ID = "container-admission-node";
const IMAGE = "ghcr.io/elizaos/eliza:stable";
const TEST_TIMEOUT_MS = 120_000;
const BLOCKED_RESPONSE_TIMEOUT_MS = 10_000;
const READINESS_DOCKER_INFO_COMMAND =
  "docker info --format '{{.ID}}|{{.Architecture}}' && { echo '---IO-PRESSURE---'; cat /proc/pressure/io 2>/dev/null || true; }";
const REGISTRY_LOGOUT_COMMAND = "docker logout 'ghcr.io' >/dev/null 2>&1";
const IMAGE_PULL_COMMAND = "docker pull 'ghcr.io/elizaos/eliza:stable'";
const IMAGE_INSPECT_COMMAND =
  "docker image inspect --format '{{json .RepoDigests}}' 'ghcr.io/elizaos/eliza:stable'";
const NETWORK_ENSURE_COMMAND =
  "docker network inspect 'containers-isolated' >/dev/null 2>&1 || docker network create --driver bridge 'containers-isolated' >/dev/null 2>&1 || docker network inspect 'containers-isolated' >/dev/null";
const DOCKER_CREATE_COMMAND_PATTERN =
  /(?:^|; )docker create --name 'cloud-container-[0-9a-f]{32}' --restart unless-stopped --network 'containers-isolated' /;
const DOCKER_START_COMMAND_PATTERN =
  /^docker start 'cloud-container-[0-9a-f]{32}'$/;

const ENV = {
  NODE_ENV: "test",
  ENVIRONMENT: "test",
  RATE_LIMIT_DISABLED: "true",
  REDIS_RATE_LIMITING: "false",
  MOCK_REDIS: "1",
  CACHE_ENABLED: "true",
  AUTO_TOP_UP_DURABLE_ENABLED: "false",
} as unknown as AppEnv["Bindings"];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

class DockerTransportRecorder {
  readonly execCommands: string[] = [];
  readonly execStdinCalls: Array<{
    command: string;
    input: string | Buffer;
  }> = [];
  readonly connectEntered = deferred();
  readonly createEntered = deferred();
  connectCalls = 0;
  private readonly connectRelease = deferred();
  private readonly createRelease = deferred();

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connectEntered.resolve();
    await this.connectRelease.promise;
  }

  async exec(command: string): Promise<string> {
    this.execCommands.push(command);
    if (command === READINESS_DOCKER_INFO_COMMAND) {
      return [
        "container-admission-docker-id|amd64",
        "---IO-PRESSURE---",
        "some avg10=0.00 avg60=0.00 avg300=0.00 total=0",
        "full avg10=0.00 avg60=0.00 avg300=0.00 total=0",
      ].join("\n");
    }
    if (command === IMAGE_INSPECT_COMMAND) return "[]";
    if (
      command === REGISTRY_LOGOUT_COMMAND ||
      command === IMAGE_PULL_COMMAND ||
      command === NETWORK_ENSURE_COMMAND ||
      DOCKER_START_COMMAND_PATTERN.test(command)
    ) {
      return "";
    }
    throw new Error(`Unexpected SSH command: ${command}`);
  }

  async execStdin(command: string, input: string | Buffer): Promise<string> {
    if (!DOCKER_CREATE_COMMAND_PATTERN.test(command)) {
      throw new Error(`Unexpected stdin SSH command: ${command}`);
    }
    this.execStdinCalls.push({ command, input });
    this.createEntered.resolve();
    await this.createRelease.promise;
    return "";
  }

  getVerifiedHostKeyFingerprint(): string {
    return "container-admission-test-fingerprint";
  }

  releaseConnect(): void {
    this.connectRelease.resolve();
  }

  releaseCreate(): void {
    this.createRelease.resolve();
  }
}

const dockerTransport = new DockerTransportRecorder();
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: USER_ID,
  organization_id: ORGANIZATION_ID,
}));
const isCodingContainerImageAllowed = mock(() => true);
const imageRequiresDigestPin = mock(() => false);

const containersRepositoryActual = await import("@/db/repositories/containers");
const originalProjectAdmission =
  containersRepositoryActual.containersRepository.createWithProjectIntentAndQuotaCheck.bind(
    containersRepositoryActual.containersRepository,
  );
const projectAdmissionSpy = spyOn(
  containersRepositoryActual.containersRepository,
  "createWithProjectIntentAndQuotaCheck",
).mockImplementation(originalProjectAdmission);

const workersHonoAuthActual = await import("@/lib/auth/workers-hono-auth");
const codingContainersActual = await import("@/lib/services/coding-containers");
const dockerSshActual = await import(
  "../../shared/src/lib/services/docker-ssh"
);
const workersHonoAuthSnapshot = { ...workersHonoAuthActual };
const codingContainersSnapshot = { ...codingContainersActual };
const dockerSshSnapshot = { ...dockerSshActual };

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthSnapshot,
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/coding-containers", () => ({
  ...codingContainersSnapshot,
  isCodingContainerImageAllowed,
  imageRequiresDigestPin,
}));
mock.module("../../shared/src/lib/services/docker-ssh", () => ({
  ...dockerSshSnapshot,
  DockerSSHClient: {
    getClient: () => dockerTransport,
  },
}));

let containersApp: Hono<AppEnv>;
let billingLimitsApp: Hono<AppEnv>;
let closeDb:
  | typeof import("@/db/client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("@/db/client").dbWrite;
let schemas: typeof import("../../shared/src/db/schemas/index");

function restoreEnv(name: keyof typeof PREVIOUS_ENV): void {
  const value = PREVIOUS_ENV[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function pushIntegrationSchema(): Promise<void> {
  const { pushSchemaToTestDb } = await import("@/db/push-schema-for-tests");
  const previousBigIntToJson = Object.getOwnPropertyDescriptor(
    BigInt.prototype,
    "toJSON",
  );
  Object.defineProperty(BigInt.prototype, "toJSON", {
    configurable: true,
    value(this: bigint) {
      return this.toString(10);
    },
  });
  try {
    await pushSchemaToTestDb({
      organizations: schemas.organizations,
      users: schemas.users,
      userIdentities: schemas.userIdentities,
      apiKeys: schemas.apiKeys,
      userCharacters: schemas.userCharacters,
      agentSandboxes: schemas.agentSandboxes,
      organizationConfig: schemas.organizationConfig,
      containers: schemas.containers,
      creditTransactions: schemas.creditTransactions,
      orgRateLimitOverrides: schemas.orgRateLimitOverrides,
      orgStorageQuota: schemas.orgStorageQuota,
      autoTopUpAttempts: schemas.autoTopUpAttempts,
      autoTopUpControl: schemas.autoTopUpControl,
      autoTopUpLegacyPaymentQuarantine:
        schemas.autoTopUpLegacyPaymentQuarantine,
      computeBillingRateSegments: schemas.computeBillingRateSegments,
      apps: schemas.apps,
      appDeploymentStatusEnum: schemas.appDeploymentStatusEnum,
      appReviewStatusEnum: schemas.appReviewStatusEnum,
      userDatabaseStatusEnum: schemas.userDatabaseStatusEnum,
      agentNodeIncarnationHistories: schemas.agentNodeIncarnationHistories,
      dockerNodes: schemas.dockerNodes,
    });
  } finally {
    if (previousBigIntToJson) {
      Object.defineProperty(BigInt.prototype, "toJSON", previousBigIntToJson);
    } else {
      Reflect.deleteProperty(BigInt.prototype, "toJSON");
    }
  }
}

beforeAll(async () => {
  schemas = await import("../../shared/src/db/schemas/index");
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import(
    "@/db/client"
  ));
  await pushIntegrationSchema();

  await dbWrite.insert(schemas.organizations).values({
    id: ORGANIZATION_ID,
    name: "Container Admission Concurrency",
    slug: "container-admission-concurrency",
    credit_balance: "0",
  });
  await dbWrite.insert(schemas.users).values({
    id: USER_ID,
    organization_id: ORGANIZATION_ID,
    steward_user_id: "container-admission-concurrency-user",
    role: "owner",
  });
  await dbWrite.insert(schemas.organizationConfig).values({
    id: ORGANIZATION_CONFIG_ID,
    organization_id: ORGANIZATION_ID,
    settings: { max_containers: 1 },
  });
  await dbWrite.insert(schemas.dockerNodes).values({
    id: DOCKER_NODE_RECORD_ID,
    node_id: DOCKER_NODE_ID,
    hostname: "container-admission-node.test",
    capacity: 1,
    enabled: true,
    placement_state: "open",
    status: "unknown",
    allocated_count: 0,
    host_key_fingerprint: "container-admission-test-fingerprint",
    metadata: { environment: "test" },
  });

  const { createApp } = await import("../src/bootstrap-app");
  containersApp = await createApp({ requestPath: "/api/v1/containers" });
  billingLimitsApp = await createApp({
    requestPath: "/api/v1/billing/limits",
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  try {
    if (closeDb) await closeDb();
  } finally {
    projectAdmissionSpy.mockRestore();
    mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthSnapshot);
    mock.module(
      "@/lib/services/coding-containers",
      () => codingContainersSnapshot,
    );
    mock.module(
      "../../shared/src/lib/services/docker-ssh",
      () => dockerSshSnapshot,
    );
    for (const name of Object.keys(PREVIOUS_ENV) as Array<
      keyof typeof PREVIOUS_ENV
    >) {
      restoreEnv(name);
    }
  }
});

async function postContainer(projectName: string): Promise<Response> {
  return containersApp.request(
    "/api/v1/containers",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "container-admission-test-key",
        "X-Request-Id": `container-admission-${projectName}`,
      },
      body: JSON.stringify({
        name: `Container ${projectName}`,
        projectName,
        image: IMAGE,
      }),
    },
    ENV,
  );
}

async function expectContainerLimitSnapshot(): Promise<void> {
  const snapshotResponse = await billingLimitsApp.request(
    "/api/v1/billing/limits",
    { headers: { "X-API-Key": "container-admission-test-key" } },
    ENV,
  );
  expect(snapshotResponse.status).toBe(200);
  const snapshotBody = (await snapshotResponse.json()) as {
    success: true;
    data: AccountBillingSnapshot;
  };
  expect(snapshotBody.success).toBe(true);
  expect(snapshotBody.data.v2.limits.containers).toMatchObject({
    used: {
      status: "available",
      value: { value: "0", unit: "count" },
    },
    reserved: {
      status: "available",
      value: { value: "1", unit: "count" },
    },
    limit: {
      status: "available",
      value: { value: "1", unit: "count" },
    },
    remaining: {
      status: "available",
      value: { value: "0", unit: "count" },
    },
  });
}

describe("container admission and provisioning through generated API routes", () => {
  test(
    "admits one request into one Docker provisioning sequence while the other receives 402",
    async () => {
      // PGlite supplies composed route/repository transaction wiring and
      // committed-row visibility here. Its in-process engine is not evidence
      // of independent PostgreSQL sessions contending on `FOR UPDATE`.
      const left = postContainer("project-left");
      const right = postContainer("project-right");
      const responseDrain = Promise.allSettled([left, right]);
      let blockedPhaseFailure: { error: unknown } | undefined;

      try {
        await withTimeout(
          dockerTransport.connectEntered.promise,
          BLOCKED_RESPONSE_TIMEOUT_MS,
          "No admitted request reached the Docker connect barrier",
        );

        const loser = await withTimeout(
          Promise.race([left, right]),
          BLOCKED_RESPONSE_TIMEOUT_MS,
          "The quota loser did not settle while the admitted request was blocked",
        );
        expect(loser.status).toBe(402);
        const loserBody = (await loser.clone().json()) as {
          success: false;
          error: string;
          quota: {
            availability: "ready";
            allowed: false;
            current: number;
            max: number;
            error: string;
          };
        };
        expect(loserBody).toEqual({
          success: false,
          error: "Container quota exceeded (1/1)",
          quota: {
            availability: "ready",
            allowed: false,
            current: 1,
            max: 1,
            error: "Container quota exceeded (1/1)",
          },
        });

        const pendingRows = await dbWrite
          .select({
            id: schemas.containers.id,
            projectName: schemas.containers.project_name,
            status: schemas.containers.status,
          })
          .from(schemas.containers);
        expect(pendingRows).toHaveLength(1);
        const pendingRow = pendingRows[0];
        if (!pendingRow)
          throw new Error("The admitted pending row was missing");
        expect(pendingRow).toMatchObject({ status: "pending" });
        expect(projectAdmissionSpy).toHaveBeenCalledTimes(2);
        expect(
          projectAdmissionSpy.mock.calls
            .map(([candidate]) => candidate.project_name)
            .sort(),
        ).toEqual(["project-left", "project-right"]);
        expect(dockerTransport.connectCalls).toBe(1);
        expect(dockerTransport.execCommands).toHaveLength(0);
        expect(dockerTransport.execStdinCalls).toHaveLength(0);
        await expectContainerLimitSnapshot();

        dockerTransport.releaseConnect();
        await withTimeout(
          dockerTransport.createEntered.promise,
          BLOCKED_RESPONSE_TIMEOUT_MS,
          "The admitted request did not reach the Docker create barrier",
        );

        const buildingRows = await dbWrite
          .select({
            id: schemas.containers.id,
            projectName: schemas.containers.project_name,
            status: schemas.containers.status,
          })
          .from(schemas.containers);
        expect(buildingRows).toHaveLength(1);
        expect(buildingRows[0]).toEqual({
          id: pendingRow.id,
          projectName: pendingRow.projectName,
          status: "building",
        });

        const [blockedNode] = await dbWrite
          .select({
            status: schemas.dockerNodes.status,
            allocatedCount: schemas.dockerNodes.allocated_count,
          })
          .from(schemas.dockerNodes);
        expect(blockedNode).toEqual({
          status: "healthy",
          allocatedCount: 0,
        });
        expect(
          dockerTransport.execCommands.filter(
            (command) => command === READINESS_DOCKER_INFO_COMMAND,
          ),
        ).toHaveLength(1);
        expect(
          dockerTransport.execCommands.filter(
            (command) => command === REGISTRY_LOGOUT_COMMAND,
          ),
        ).toHaveLength(1);
        expect(
          dockerTransport.execCommands.filter(
            (command) => command === IMAGE_PULL_COMMAND,
          ),
        ).toHaveLength(1);
        expect(
          dockerTransport.execCommands.filter(
            (command) => command === IMAGE_INSPECT_COMMAND,
          ),
        ).toHaveLength(1);
        expect(
          dockerTransport.execCommands.filter(
            (command) => command === NETWORK_ENSURE_COMMAND,
          ),
        ).toHaveLength(1);
        expect(dockerTransport.execCommands).toHaveLength(5);
        expect(
          dockerTransport.execStdinCalls.filter(({ command }) =>
            DOCKER_CREATE_COMMAND_PATTERN.test(command),
          ),
        ).toHaveLength(1);
        expect(
          dockerTransport.execCommands.filter((command) =>
            DOCKER_START_COMMAND_PATTERN.test(command),
          ),
        ).toHaveLength(0);
      } catch (error) {
        blockedPhaseFailure = { error };
      } finally {
        dockerTransport.releaseConnect();
        dockerTransport.releaseCreate();
      }

      let responseSettlements: PromiseSettledResult<Response>[];
      try {
        responseSettlements = await withTimeout(
          responseDrain,
          BLOCKED_RESPONSE_TIMEOUT_MS,
          "The admitted request did not settle after releasing Docker create",
        );
      } catch (drainError) {
        if (blockedPhaseFailure) throw blockedPhaseFailure.error;
        throw drainError;
      }
      if (blockedPhaseFailure) throw blockedPhaseFailure.error;
      const responses = responseSettlements.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      expect(
        responses.map((response) => response.status).sort((a, b) => a - b),
      ).toEqual([201, 402]);
      const createdResponse = responses.find(
        (response) => response.status === 201,
      );
      if (!createdResponse)
        throw new Error("The admitted response was missing");
      const createdBody = (await createdResponse.json()) as {
        success: true;
        data: { id: string; project_name: string };
      };

      const finalRows = await dbWrite
        .select({
          id: schemas.containers.id,
          projectName: schemas.containers.project_name,
          status: schemas.containers.status,
          nodeId: schemas.containers.node_id,
        })
        .from(schemas.containers);
      expect(finalRows).toHaveLength(1);
      const finalRow = finalRows[0];
      if (!finalRow) throw new Error("The admitted final row was missing");
      expect(finalRow).toMatchObject({
        status: "deploying",
        nodeId: DOCKER_NODE_ID,
      });
      expect(createdBody).toMatchObject({
        success: true,
        data: {
          id: finalRow.id,
          project_name: finalRow.projectName,
        },
      });
      expect(["project-left", "project-right"]).toContain(finalRow.projectName);

      const [finalNode] = await dbWrite
        .select({
          status: schemas.dockerNodes.status,
          allocatedCount: schemas.dockerNodes.allocated_count,
        })
        .from(schemas.dockerNodes);
      expect(finalNode).toEqual({ status: "healthy", allocatedCount: 1 });
      expect(
        dockerTransport.execCommands.filter(
          (command) => command === READINESS_DOCKER_INFO_COMMAND,
        ),
      ).toHaveLength(1);
      expect(
        dockerTransport.execCommands.filter(
          (command) => command === REGISTRY_LOGOUT_COMMAND,
        ),
      ).toHaveLength(1);
      expect(
        dockerTransport.execCommands.filter(
          (command) => command === IMAGE_PULL_COMMAND,
        ),
      ).toHaveLength(1);
      expect(
        dockerTransport.execCommands.filter(
          (command) => command === IMAGE_INSPECT_COMMAND,
        ),
      ).toHaveLength(1);
      expect(
        dockerTransport.execCommands.filter(
          (command) => command === NETWORK_ENSURE_COMMAND,
        ),
      ).toHaveLength(1);
      expect(dockerTransport.execStdinCalls).toHaveLength(1);

      const expectedContainerName = `cloud-container-${finalRow.id.replaceAll("-", "")}`;
      const [dockerCreate] = dockerTransport.execStdinCalls;
      if (!dockerCreate)
        throw new Error("The Docker create command was missing");
      expect(dockerCreate.command).toContain(
        `docker create --name '${expectedContainerName}' --restart unless-stopped`,
      );
      expect(
        dockerTransport.execCommands.filter((command) =>
          DOCKER_START_COMMAND_PATTERN.test(command),
        ),
      ).toEqual([`docker start '${expectedContainerName}'`]);
      expect(dockerTransport.execCommands).toHaveLength(6);

      await expectContainerLimitSnapshot();
    },
    TEST_TIMEOUT_MS,
  );
});
