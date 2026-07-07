/**
 * Route tests for the docker-node bootstrap-callback identity guard (#12876).
 *
 * Exercises the re-bootstrap rule on the EXISTING-node branch: a client cannot
 * rewrite a node's SSH identity (hostname/ssh_user/ssh_port) via the shared
 * bootstrap secret alone; only a request presenting the pinned host key
 * fingerprint may change it. Uses a deterministic in-memory repository stub —
 * the guard is pure route logic, so no DB is needed to prove the behavior.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as dockerNodesActual from "@/db/repositories/docker-nodes";
import * as loggerActual from "@/lib/utils/logger";

interface StoredNode {
  id: string;
  node_id: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  capacity: number;
  host_key_fingerprint: string | null;
  status: string;
  metadata: Record<string, unknown>;
}

const EXISTING: StoredNode = {
  id: "node-row-1",
  node_id: "node-1",
  hostname: "10.0.0.1",
  ssh_port: 22,
  ssh_user: "root",
  capacity: 8,
  host_key_fingerprint: "SHA256:pinned-fingerprint",
  status: "healthy",
  metadata: { provider: "operator-provisioned" },
};

let stored: StoredNode | null = EXISTING;
let lastUpdateArg: Partial<StoredNode> | null = null;

const mockFindByNodeId = mock(async (_nodeId: string) => stored);
const mockUpdate = mock(async (_id: string, data: Partial<StoredNode>) => {
  lastUpdateArg = data;
  if (!stored) return null;
  stored = { ...stored, ...data };
  return stored;
});
const mockCreate = mock(async (data: StoredNode) => {
  stored = { ...data, id: "node-row-new" };
  return stored;
});

mock.module("@/db/repositories/docker-nodes", () => ({
  ...dockerNodesActual,
  dockerNodesRepository: {
    ...dockerNodesActual.dockerNodesRepository,
    findByNodeId: mockFindByNodeId,
    update: mockUpdate,
    create: mockCreate,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

const BOOTSTRAP_SECRET = "test-bootstrap-secret";
process.env.CONTAINERS_BOOTSTRAP_SECRET = BOOTSTRAP_SECRET;

const { default: app } = await import(
  "../v1/admin/docker-nodes/bootstrap-callback/route"
);

async function post(body: Record<string, unknown>): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bootstrap-secret": BOOTSTRAP_SECRET,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("bootstrap-callback node-identity guard (#12876)", () => {
  beforeEach(() => {
    stored = { ...EXISTING, metadata: { ...EXISTING.metadata } };
    lastUpdateArg = null;
    mockUpdate.mockClear();
    mockCreate.mockClear();
    mockFindByNodeId.mockClear();
  });

  test("rejects hostname mutation on existing node without the required fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.6.6.6", // attacker-controlled MITM host
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain("Validation failed");

    // The SSH identity must NOT have been written.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored?.hostname).toBe("10.0.0.1");
    expect(stored?.ssh_user).toBe("root");
    expect(stored?.ssh_port).toBe(22);
  });

  test("rejects ssh_user mutation without a matching fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "attacker",
      hostKeyFingerprint: "SHA256:wrong-fingerprint",
    });

    expect(res.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored?.ssh_user).toBe("root");
  });

  test("rejects ssh_port mutation without a matching fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshPort: 2222,
      hostKeyFingerprint: "SHA256:wrong-fingerprint",
    });

    expect(res.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored?.ssh_port).toBe(22);
  });

  test("rejects identity mutation when the node has no pinned fingerprint at all", async () => {
    stored = {
      ...EXISTING,
      host_key_fingerprint: null,
      metadata: { ...EXISTING.metadata },
    };

    const res = await post({
      nodeId: "node-1",
      hostname: "10.6.6.6",
      hostKeyFingerprint: "SHA256:anything",
    });

    expect(res.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored?.hostname).toBe("10.0.0.1");
  });

  test("allows first host-key pin on an existing autoscaler placeholder when identity is unchanged", async () => {
    stored = {
      ...EXISTING,
      host_key_fingerprint: null,
      metadata: { provider: "hetzner-cloud", autoscaled: true },
    };

    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "root",
      sshPort: 22,
      hostKeyFingerprint: "SHA256:first-real-pin",
    });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(lastUpdateArg?.host_key_fingerprint).toBe("SHA256:first-real-pin");
    expect(stored?.host_key_fingerprint).toBe("SHA256:first-real-pin");
  });

  test("allows identity mutation with a matching pinned fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.9",
      sshUser: "deploy",
      sshPort: 2200,
      hostKeyFingerprint: "SHA256:pinned-fingerprint",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(lastUpdateArg?.hostname).toBe("10.0.0.9");
    expect(lastUpdateArg?.ssh_user).toBe("deploy");
    expect(lastUpdateArg?.ssh_port).toBe(2200);
  });

  test("liveness re-bootstrap with unchanged identity succeeds with the matching fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "root",
      sshPort: 22,
      capacity: 16,
      hostKeyFingerprint: "SHA256:pinned-fingerprint",
    });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // Identity preserved. Capacity is operator-owned once the row exists, so a
    // re-bootstrap must NOT write it — the request value is ignored here.
    expect(lastUpdateArg?.hostname).toBe("10.0.0.1");
    expect(lastUpdateArg?.ssh_user).toBe("root");
    expect(lastUpdateArg?.ssh_port).toBe(22);
    expect(lastUpdateArg).not.toHaveProperty("capacity");
  });

  test("re-bootstrap preserves an operator-tuned capacity (does not reset to the request/default)", async () => {
    // A 252 GB robot the operator hand-tuned to 24 slots via a direct DB write.
    stored = { ...EXISTING, capacity: 24, metadata: { ...EXISTING.metadata } };

    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "root",
      sshPort: 22,
      // Callback reports the small-box default; it must not clobber the tune.
      capacity: 8,
      hostKeyFingerprint: "SHA256:pinned-fingerprint",
    });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(lastUpdateArg).not.toHaveProperty("capacity");
    expect(stored?.capacity).toBe(24);
  });

  test("brand-new node still gets its capacity stamped from the request", async () => {
    stored = null; // findByNodeId returns null → insert path
    let createdCapacity: number | undefined;
    mockCreate.mockImplementationOnce(async (data: StoredNode) => {
      createdCapacity = data.capacity;
      stored = { ...data, id: "node-row-new" };
      return stored;
    });

    const res = await post({
      nodeId: "node-3",
      hostname: "10.0.0.60",
      sshUser: "root",
      sshPort: 22,
      capacity: 24,
      hostKeyFingerprint: "SHA256:new-node",
    });

    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(createdCapacity).toBe(24);
  });

  test("rejects liveness re-bootstrap without the required pinned fingerprint", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "root",
      sshPort: 22,
    });

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("rejects host-key fingerprint mutation even when SSH identity is unchanged", async () => {
    const res = await post({
      nodeId: "node-1",
      hostname: "10.0.0.1",
      sshUser: "root",
      sshPort: 22,
      hostKeyFingerprint: "SHA256:attacker-first-pin",
    });

    expect(res.status).toBe(409);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain("Host key fingerprint");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored?.host_key_fingerprint).toBe("SHA256:pinned-fingerprint");
  });

  test("first bootstrap of a brand-new node still creates the row", async () => {
    stored = null; // findByNodeId returns null → insert path

    const res = await post({
      nodeId: "node-2",
      hostname: "10.0.0.50",
      sshUser: "root",
      sshPort: 22,
      hostKeyFingerprint: "SHA256:new-node",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { action: string } };
    expect(json.data.action).toBe("created");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("rejects unauthorized requests (bad secret) before any DB access", async () => {
    const res = await app.fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "wrong-secret",
        },
        body: JSON.stringify({ nodeId: "node-1", hostname: "10.6.6.6" }),
      }),
    );

    expect(res.status).toBe(401);
    expect(mockFindByNodeId).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
