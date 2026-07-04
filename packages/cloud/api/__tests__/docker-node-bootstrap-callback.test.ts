/**
 * Bootstrap-callback SSH-target immutability (finding M2, #12876 / #12227).
 *
 * The bootstrap secret sits in every node's cloud-init user_data, so any single
 * node compromise leaks it. These tests pin the invariant that a caller holding
 * only that secret can NOT re-point an existing node's SSH target (hostname /
 * ssh_user / ssh_port) nor swap its pinned host key — which would let them MITM
 * the control plane's SSH. The pure `evaluateBootstrap` guard is exercised
 * directly; the route tests drive the real Hono handler with a mocked repository
 * to prove the persisted SSH params are never rewritten on a re-bootstrap.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Mock the DB/logger before importing the route so loading it never pulls the
// real repository chain (cloud-shared → core → @elizaos/cloud-routing).
const BOOTSTRAP_SECRET = "test-bootstrap-secret";
process.env.CONTAINERS_BOOTSTRAP_SECRET = BOOTSTRAP_SECRET;

const findByNodeId = mock();
const update = mock();
const create = mock();
mock.module("@/db/repositories/docker-nodes", () => ({
  dockerNodesRepository: { findByNodeId, update, create },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const { default: bootstrapRoute, evaluateBootstrap } = (await import(
  "../v1/admin/docker-nodes/bootstrap-callback/route"
)) as typeof import("../v1/admin/docker-nodes/bootstrap-callback/route");
type BootstrapIdentity = Parameters<typeof evaluateBootstrap>[1];

const EXISTING = {
  hostname: "node-1.hetzner.example",
  ssh_port: 22,
  ssh_user: "root",
  host_key_fingerprint: "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const MATCHING_INPUT: BootstrapIdentity = {
  hostname: EXISTING.hostname,
  sshPort: EXISTING.ssh_port,
  sshUser: EXISTING.ssh_user,
  hostKeyFingerprint: EXISTING.host_key_fingerprint,
};

describe("evaluateBootstrap", () => {
  test("fresh node (no existing row) is a create", () => {
    expect(evaluateBootstrap(null, MATCHING_INPUT)).toEqual({
      action: "create",
    });
  });

  test("identical re-bootstrap of an existing node is a liveness update", () => {
    expect(evaluateBootstrap(EXISTING, MATCHING_INPUT)).toEqual({
      action: "update",
    });
  });

  test("changing hostname of an existing node is rejected 409", () => {
    const res = evaluateBootstrap(EXISTING, {
      ...MATCHING_INPUT,
      hostname: "attacker.mitm.example",
    });
    expect(res).toMatchObject({ action: "reject", status: 409 });
  });

  test("changing ssh_user of an existing node is rejected 409", () => {
    const res = evaluateBootstrap(EXISTING, {
      ...MATCHING_INPUT,
      sshUser: "mallory",
    });
    expect(res).toMatchObject({ action: "reject", status: 409 });
  });

  test("changing ssh_port of an existing node is rejected 409", () => {
    const res = evaluateBootstrap(EXISTING, {
      ...MATCHING_INPUT,
      sshPort: 2222,
    });
    expect(res).toMatchObject({ action: "reject", status: 409 });
  });

  test("a missing host_key_fingerprint is rejected 400", () => {
    const res = evaluateBootstrap(null, {
      ...MATCHING_INPUT,
      hostKeyFingerprint: "",
    });
    expect(res).toMatchObject({ action: "reject", status: 400 });
  });

  test("swapping an already-pinned host key is rejected 409", () => {
    const res = evaluateBootstrap(EXISTING, {
      ...MATCHING_INPUT,
      hostKeyFingerprint: "SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(res).toMatchObject({ action: "reject", status: 409 });
  });

  test("a never-pinned node may set its fingerprint when the SSH target is unchanged", () => {
    const neverPinned = { ...EXISTING, host_key_fingerprint: null };
    expect(evaluateBootstrap(neverPinned, MATCHING_INPUT)).toEqual({
      action: "update",
    });
  });
});

const app = new Hono();
app.route("/", bootstrapRoute);

function post(body: unknown, secret: string | null = BOOTSTRAP_SECRET) {
  return app.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-bootstrap-secret": secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  nodeId: "node-1",
  hostname: EXISTING.hostname,
  sshPort: EXISTING.ssh_port,
  sshUser: EXISTING.ssh_user,
  hostKeyFingerprint: EXISTING.host_key_fingerprint,
};

describe("POST /v1/admin/docker-nodes/bootstrap-callback", () => {
  beforeEach(() => {
    findByNodeId.mockReset();
    update.mockReset();
    create.mockReset();
  });

  test("rejects a bad secret with 401 and never touches the DB", async () => {
    const res = await post(VALID_BODY, "wrong-secret");
    expect(res.status).toBe(401);
    expect(findByNodeId).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test("rejects a fingerprint-less body with 400", async () => {
    const { hostKeyFingerprint: _drop, ...noFingerprint } = VALID_BODY;
    const res = await post(noFingerprint);
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test("refuses to re-point an existing node's hostname (409) and does not write", async () => {
    findByNodeId.mockResolvedValue({ id: "row-1", metadata: {}, ...EXISTING });

    const res = await post({
      ...VALID_BODY,
      hostname: "attacker.mitm.example",
    });
    const body = (await res.json()) as { success: boolean; error: string };

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test("an allowed re-bootstrap updates liveness WITHOUT rewriting the SSH target", async () => {
    findByNodeId.mockResolvedValue({ id: "row-1", metadata: {}, ...EXISTING });
    update.mockResolvedValue({ id: "row-1", ...EXISTING });

    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);

    expect(update).toHaveBeenCalledTimes(1);
    const [, patch] = update.mock.calls[0] as [string, Record<string, unknown>];
    expect(patch).not.toHaveProperty("hostname");
    expect(patch).not.toHaveProperty("ssh_user");
    expect(patch).not.toHaveProperty("ssh_port");
  });

  test("a brand-new node is inserted with its declared SSH target", async () => {
    findByNodeId.mockResolvedValue(null);
    create.mockResolvedValue({ id: "row-2", ...EXISTING });

    const res = await post({ ...VALID_BODY, nodeId: "node-2" });
    expect(res.status).toBe(200);

    expect(create).toHaveBeenCalledTimes(1);
    const [payload] = create.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({
      node_id: "node-2",
      hostname: EXISTING.hostname,
      ssh_user: EXISTING.ssh_user,
      ssh_port: EXISTING.ssh_port,
    });
  });
});
