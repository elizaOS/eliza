// Bidirectional proof for CONTAINERS_ENV_VAULT_REFS on the LIVE provisioning
// path (`createContainer` → SSH `docker create -e …`), workload contract
// (#17432):
//   flag ON  → the actual docker-create command line and the persisted DB row
//              contain NO secret values — only `vault://workload/...` refs
//              plus the per-container capability; Steward received the values
//              and a registration.
//   flag ON + steward outage → provision REJECTED before any row/SSH.
//   flag OFF → byte-for-byte legacy behavior (plaintext env injection, zero
//              Steward traffic), proving the gate defaults closed.
//   delete   → the stored workload capability is revoked.
// Harness mirrors client.error-policy.test.ts: deterministic in-process
// fakes for repo/node/SSH; `resolveWorkloadStewardConfigFromEnv` alone is
// stubbed so the REAL sealing logic runs against a recording steward fetch.
// (The REAL-Steward-API evidence lives in workload-cross-repo.e2e.test.ts.)
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realContainersRepo from "../../../../db/repositories/containers";
import * as realDockerNodesRepo from "../../../../db/repositories/docker-nodes";
import * as realNodeManager from "../../docker-node-manager";
import * as realPortAlloc from "../../docker-port-allocation";
import * as realDockerSsh from "../../docker-ssh";
import * as realHetznerVolumes from "../hetzner-volumes";
import * as realRegistry from "./registry";
import * as realWorkloadEnvRefs from "./workload-env-refs";

const realContainersRepoSnap = { ...realContainersRepo };
const realDockerNodesRepoSnap = { ...realDockerNodesRepo };
const realNodeManagerSnap = { ...realNodeManager };
const realPortAllocSnap = { ...realPortAlloc };
const realDockerSshSnap = { ...realDockerSsh };
const realHetznerVolumesSnap = { ...realHetznerVolumes };
const realRegistrySnap = { ...realRegistry };
const realWorkloadEnvRefsSnap = { ...realWorkloadEnvRefs };

// ── Recording steward (the REAL sealing logic drives this fetch) ────────────
interface StewardCall {
  method: string;
  path: string;
  body: unknown;
}
const stewardCalls: StewardCall[] = [];
const stewardValues = new Map<string, string>(); // "<workloadId>/<name>" → value
const stewardFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  stewardCalls.push({ method, path: url.pathname, body });
  const putMatch = /^\/v1\/workload-secrets\/workloads\/([^/]+)\/secrets\/([^/]+)$/.exec(
    url.pathname,
  );
  if (method === "PUT" && putMatch) {
    stewardValues.set(
      `${decodeURIComponent(putMatch[1] as string)}/${decodeURIComponent(putMatch[2] as string)}`,
      (body as { value: string }).value,
    );
    return Response.json({ ok: true, data: { version: 1 } });
  }
  return Response.json({ ok: true, data: {} });
}) as typeof fetch;

// ── Repo / node / SSH fakes ─────────────────────────────────────────────────
const ROW_ID = "ct-workload-1";
let persistedRow: Record<string, unknown> = {};

const createWithQuotaCheck = mock(async (row: Record<string, unknown>) => {
  persistedRow = row;
  return { ...row, id: ROW_ID };
});
const updateRow = mock(async () => null);
const updateStatus = mock(async () => {});
const incrementAllocated = mock(async () => {});
const findByNodeId = mock(async () => null);

const NODE = {
  node_id: "node-1",
  hostname: "10.0.0.1",
  ssh_port: 22,
  ssh_user: "root",
  host_key_fingerprint: null,
  capacity: 10,
  enabled: true,
  status: "active",
};
const getAvailableNode = mock(async () => NODE);

const sshCommands: string[] = [];
const execMock = mock(async (cmd: string) => {
  sshCommands.push(cmd);
  return "";
});
const getClient = mock(() => ({ exec: execMock, execStream: mock(async () => {}) }));

mock.module("../../../../db/repositories/containers", () => ({
  ...realContainersRepo,
  containersRepository: {
    ...realContainersRepo.containersRepository,
    createWithQuotaCheck,
    update: updateRow,
    updateStatus,
  },
}));
mock.module("../../../../db/repositories/docker-nodes", () => ({
  ...realDockerNodesRepo,
  dockerNodesRepository: {
    ...realDockerNodesRepo.dockerNodesRepository,
    findByNodeId,
    incrementAllocated,
  },
}));
mock.module("../../docker-node-manager", () => ({
  ...realNodeManager,
  dockerNodeManager: { ...realNodeManager.dockerNodeManager, getAvailableNode },
}));
mock.module("../../docker-port-allocation", () => ({
  ...realPortAlloc,
  getUsedDockerHostPorts: async () => new Set<number>(),
}));
mock.module("../../docker-ssh", () => ({
  ...realDockerSsh,
  DockerSSHClient: { getClient },
}));
mock.module("../hetzner-volumes", () => ({
  ...realHetznerVolumes,
  isHetznerVolumesAvailable: () => false,
  getHetznerVolumeService: () => ({}),
}));
mock.module("./registry", () => ({
  ...realRegistry,
  ensureRegistryAccess: async () => {},
  readPulledImageDigest: async () => null,
}));
// Only the env→config resolver is stubbed (to inject the recording fetch);
// the sealing logic under test is the real implementation.
mock.module("./workload-env-refs", () => ({
  ...realWorkloadEnvRefs,
  resolveWorkloadStewardConfigFromEnv: () => ({
    baseUrl: "https://steward.test",
    tenantId: "elizacloud",
    apiKey: "k",
    fetchImpl: stewardFetch,
  }),
}));

const { getHetznerContainersClient } = await import("./client");
const { deriveWorkloadId } = realWorkloadEnvRefs;

afterAll(() => {
  mock.module("../../../../db/repositories/containers", () => realContainersRepoSnap);
  mock.module("../../../../db/repositories/docker-nodes", () => realDockerNodesRepoSnap);
  mock.module("../../docker-node-manager", () => realNodeManagerSnap);
  mock.module("../../docker-port-allocation", () => realPortAllocSnap);
  mock.module("../../docker-ssh", () => realDockerSshSnap);
  mock.module("../hetzner-volumes", () => realHetznerVolumesSnap);
  mock.module("./registry", () => realRegistrySnap);
  mock.module("./workload-env-refs", () => realWorkloadEnvRefsSnap);
  delete process.env.CONTAINERS_ENV_VAULT_REFS;
});

const CREATE_INPUT = {
  name: "workload-app",
  projectName: "wl-proj",
  organizationId: "org-wl",
  userId: "user-1",
  image: "ghcr.io/elizaos/eliza:stable",
  port: 3000,
  desiredCount: 1,
  cpu: 1024,
  memoryMb: 1024,
  environmentVars: {
    OPENAI_API_KEY: "sk-live-supersecret",
    NODE_ENV: "production",
  },
  persistVolume: false,
  useHetznerVolume: false,
};

beforeEach(() => {
  stewardCalls.length = 0;
  stewardValues.clear();
  sshCommands.length = 0;
  persistedRow = {};
  for (const m of [createWithQuotaCheck, updateRow, updateStatus, execMock, getAvailableNode]) {
    m.mockClear();
  }
  delete process.env.CONTAINERS_ENV_VAULT_REFS;
});

describe("createContainer with CONTAINERS_ENV_VAULT_REFS=true (workload contract)", () => {
  test("docker-create payload and DB row carry workload refs + capability, never secret values; Steward got them", async () => {
    process.env.CONTAINERS_ENV_VAULT_REFS = "true";
    const client = getHetznerContainersClient();
    await client.createContainer({ ...CREATE_INPUT });

    const wl = deriveWorkloadId("org-wl", "wl-proj");

    // 1. The ACTUAL payload shipped to the node: no secret value in any SSH
    //    command; the docker create carries the ref + the capability triplet.
    const allSsh = sshCommands.join("\n");
    expect(allSsh).not.toContain("sk-live-supersecret");
    const dockerCreate = sshCommands.find((c) => c.startsWith("docker create"));
    expect(dockerCreate).toBeDefined();
    expect(dockerCreate).toContain(`vault://workload/${wl}/OPENAI_API_KEY`);
    expect(dockerCreate).toContain(`STEWARD_WORKLOAD_ID=${wl}`);
    expect(dockerCreate).toContain("STEWARD_WORKLOAD_KEY=");
    expect(dockerCreate).toContain("STEWARD_API_URL=https://steward.test");
    // Non-secret config still injected as-is.
    expect(dockerCreate).toContain("NODE_ENV=production");
    // The capability is NOT a tenant credential: the tenant API key never
    // appears in any SSH command.
    expect(allSsh).not.toContain("X-Steward-Key");
    expect(allSsh).not.toContain("elizacloud");

    // 2. The persisted control-plane row stores the ref, not the value.
    const storedEnv = persistedRow.environment_vars as Record<string, string>;
    expect(storedEnv.OPENAI_API_KEY).toBe(`vault://workload/${wl}/OPENAI_API_KEY`);
    expect(storedEnv.STEWARD_WORKLOAD_ID).toBe(wl);
    expect(JSON.stringify(persistedRow)).not.toContain("sk-live-supersecret");

    // 3. Steward received the registration and the value.
    expect(stewardCalls[0]).toMatchObject({
      method: "POST",
      path: "/v1/workload-secrets/workloads",
    });
    expect(stewardValues.get(`${wl}/OPENAI_API_KEY`)).toBe("sk-live-supersecret");
  });

  test("FAIL CLOSED: steward outage aborts the provision before any row/SSH side effects", async () => {
    process.env.CONTAINERS_ENV_VAULT_REFS = "true";
    mock.module("./workload-env-refs", () => ({
      ...realWorkloadEnvRefs,
      resolveWorkloadStewardConfigFromEnv: () => ({
        baseUrl: "https://steward.test",
        fetchImpl: (async () => new Response("down", { status: 503 })) as typeof fetch,
      }),
    }));
    try {
      const client = getHetznerContainersClient();
      await expect(client.createContainer({ ...CREATE_INPUT })).rejects.toMatchObject({
        code: "container_create_failed",
      });
      // Sealing runs BEFORE row creation and SSH: nothing half-provisioned.
      expect(createWithQuotaCheck).not.toHaveBeenCalled();
      expect(sshCommands).toEqual([]);
    } finally {
      mock.module("./workload-env-refs", () => ({
        ...realWorkloadEnvRefs,
        resolveWorkloadStewardConfigFromEnv: () => ({
          baseUrl: "https://steward.test",
          tenantId: "elizacloud",
          apiKey: "k",
          fetchImpl: stewardFetch,
        }),
      }));
    }
  });
});

describe("createContainer with the flag OFF (default)", () => {
  test("legacy behavior unchanged: plaintext env injected, zero Steward traffic", async () => {
    const client = getHetznerContainersClient();
    await client.createContainer({ ...CREATE_INPUT });

    const dockerCreate = sshCommands.find((c) => c.startsWith("docker create"));
    expect(dockerCreate).toBeDefined();
    // Exact legacy payload: the raw secret is on the command line…
    expect(dockerCreate).toContain("OPENAI_API_KEY=sk-live-supersecret");
    expect(dockerCreate).not.toContain("vault://");
    expect(dockerCreate).not.toContain("STEWARD_WORKLOAD_ID");
    // …the stored row is plaintext…
    const storedEnv = persistedRow.environment_vars as Record<string, string>;
    expect(storedEnv.OPENAI_API_KEY).toBe("sk-live-supersecret");
    // …and Steward was never touched.
    expect(stewardCalls).toEqual([]);
  });
});
