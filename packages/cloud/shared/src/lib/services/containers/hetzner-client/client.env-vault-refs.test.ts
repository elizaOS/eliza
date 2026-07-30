// Bidirectional proof for CONTAINERS_ENV_VAULT_REFS on the LIVE provisioning
// path (`createContainer` → SSH `docker create -e …`):
//   flag ON  → the actual docker-create command line and the persisted DB row
//              contain NO secret values (only `vault://` refs); the steward
//              vault holds the values.
//   flag OFF → byte-for-byte legacy behavior (plaintext env injection),
//              proving the gate defaults closed and is backward compatible.
// Harness mirrors client.error-policy.test.ts: deterministic in-process fakes,
// no live node/DB/steward. `resolveStewardConfigFromEnv` alone is stubbed so
// the REAL sealing logic runs against an in-memory steward fetch.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realContainersRepo from "../../../../db/repositories/containers";
import * as realDockerNodesRepo from "../../../../db/repositories/docker-nodes";
import * as realNodeManager from "../../docker-node-manager";
import * as realPortAlloc from "../../docker-port-allocation";
import * as realDockerSsh from "../../docker-ssh";
import * as realHetznerVolumes from "../hetzner-volumes";
import * as realEnvVaultRefs from "./env-vault-refs";
import * as realRegistry from "./registry";

const realContainersRepoSnap = { ...realContainersRepo };
const realDockerNodesRepoSnap = { ...realDockerNodesRepo };
const realNodeManagerSnap = { ...realNodeManager };
const realPortAllocSnap = { ...realPortAlloc };
const realDockerSshSnap = { ...realDockerSsh };
const realHetznerVolumesSnap = { ...realHetznerVolumes };
const realRegistrySnap = { ...realRegistry };
const realEnvVaultRefsSnap = { ...realEnvVaultRefs };

// ── In-memory steward (real sealing logic runs against this fetch) ──────────
const stewardSecrets = new Map<string, { id: string; value: string }>();
const stewardFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (method === "POST" && url.pathname === "/secrets") {
    const body = JSON.parse(String(init?.body)) as { name: string; value: string };
    if (stewardSecrets.has(body.name)) {
      return Response.json({ ok: false }, { status: 409 });
    }
    stewardSecrets.set(body.name, { id: `sec-${stewardSecrets.size + 1}`, value: body.value });
    return Response.json({ ok: true }, { status: 201 });
  }
  if (method === "GET" && url.pathname === "/secrets") {
    const data = [...stewardSecrets.entries()].map(([name, row]) => ({ id: row.id, name }));
    return Response.json({ ok: true, data });
  }
  const putMatch = /^\/secrets\/([^/]+)$/.exec(url.pathname);
  if (method === "PUT" && putMatch) {
    const body = JSON.parse(String(init?.body)) as { value: string };
    for (const row of stewardSecrets.values()) {
      if (row.id === decodeURIComponent(putMatch[1] as string)) {
        row.value = body.value;
        return Response.json({ ok: true });
      }
    }
    return Response.json({ ok: false }, { status: 404 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

// ── Repo / node / SSH fakes ─────────────────────────────────────────────────
const ROW_ID = "ct-vault-1";
let persistedRow: Record<string, unknown> = {};

const createWithQuotaCheck = mock(async (row: Record<string, unknown>) => {
  persistedRow = row;
  return { ...row, id: ROW_ID };
});
const updateRow = mock(async (_id: string, _org: string, patch: Record<string, unknown>) => {
  void patch;
  return null;
});
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
// Only the env→config resolver is stubbed (to inject the in-memory fetch);
// the sealing logic under test is the real implementation.
mock.module("./env-vault-refs", () => ({
  ...realEnvVaultRefs,
  resolveStewardConfigFromEnv: () => ({
    baseUrl: "https://steward.test",
    tenantId: "elizacloud",
    apiKey: "k",
    fetchImpl: stewardFetch,
  }),
}));

const { getHetznerContainersClient } = await import("./client");
const { buildContainerEnvVaultKey } = realEnvVaultRefs;

afterAll(() => {
  mock.module("../../../../db/repositories/containers", () => realContainersRepoSnap);
  mock.module("../../../../db/repositories/docker-nodes", () => realDockerNodesRepoSnap);
  mock.module("../../docker-node-manager", () => realNodeManagerSnap);
  mock.module("../../docker-port-allocation", () => realPortAllocSnap);
  mock.module("../../docker-ssh", () => realDockerSshSnap);
  mock.module("../hetzner-volumes", () => realHetznerVolumesSnap);
  mock.module("./registry", () => realRegistrySnap);
  mock.module("./env-vault-refs", () => realEnvVaultRefsSnap);
  delete process.env.CONTAINERS_ENV_VAULT_REFS;
});

const CREATE_INPUT = {
  name: "vault-app",
  projectName: "vault-proj",
  organizationId: "org-vault",
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
  stewardSecrets.clear();
  sshCommands.length = 0;
  persistedRow = {};
  for (const m of [createWithQuotaCheck, updateRow, updateStatus, execMock, getAvailableNode]) {
    m.mockClear();
  }
  delete process.env.CONTAINERS_ENV_VAULT_REFS;
});

describe("createContainer with CONTAINERS_ENV_VAULT_REFS=true", () => {
  test("docker-create payload and DB row carry vault:// refs, never secret values; vault holds them", async () => {
    process.env.CONTAINERS_ENV_VAULT_REFS = "true";
    const client = getHetznerContainersClient();
    await client.createContainer({ ...CREATE_INPUT });

    // 1. The ACTUAL payload shipped to the node: no secret value anywhere in
    //    any SSH command; the docker create carries the ref sentinel.
    const allSsh = sshCommands.join("\n");
    expect(allSsh).not.toContain("sk-live-supersecret");
    const vaultKey = buildContainerEnvVaultKey("org-vault", "vault-proj", "OPENAI_API_KEY");
    const dockerCreate = sshCommands.find((c) => c.startsWith("docker create"));
    expect(dockerCreate).toBeDefined();
    expect(dockerCreate).toContain(`vault://${vaultKey}`);
    // Non-secret config still injected as-is.
    expect(dockerCreate).toContain("NODE_ENV=production");

    // 2. The persisted control-plane row stores the ref, not the value.
    const storedEnv = persistedRow.environment_vars as Record<string, string>;
    expect(storedEnv.OPENAI_API_KEY).toBe(`vault://${vaultKey}`);
    expect(JSON.stringify(persistedRow)).not.toContain("sk-live-supersecret");

    // 3. The vault contains the real value under the ref key.
    expect(stewardSecrets.get(vaultKey)?.value).toBe("sk-live-supersecret");
  });

  test("FAIL CLOSED: steward outage aborts the provision before any row/SSH side effects", async () => {
    process.env.CONTAINERS_ENV_VAULT_REFS = "true";
    mock.module("./env-vault-refs", () => ({
      ...realEnvVaultRefs,
      resolveStewardConfigFromEnv: () => ({
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
      mock.module("./env-vault-refs", () => ({
        ...realEnvVaultRefs,
        resolveStewardConfigFromEnv: () => ({
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
  test("legacy behavior unchanged: plaintext env injected, no vault traffic", async () => {
    const client = getHetznerContainersClient();
    await client.createContainer({ ...CREATE_INPUT });

    const dockerCreate = sshCommands.find((c) => c.startsWith("docker create"));
    expect(dockerCreate).toBeDefined();
    // Exact legacy payload: the raw secret is on the command line…
    expect(dockerCreate).toContain("OPENAI_API_KEY=sk-live-supersecret");
    expect(dockerCreate).not.toContain("vault://");
    // …the stored row is plaintext…
    const storedEnv = persistedRow.environment_vars as Record<string, string>;
    expect(storedEnv.OPENAI_API_KEY).toBe("sk-live-supersecret");
    // …and the steward vault was never touched.
    expect(stewardSecrets.size).toBe(0);
  });
});
