/**
 * Exercises the real Docker-node drain route with deterministic admin and
 * autoscaler boundaries, including the request body that gates mutation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const drainCalls: Array<{
  nodeId: string;
  options: { deprovision: boolean };
}> = [];

mock.module("@/lib/auth", () => ({
  requireAdmin: async () => ({ role: "super_admin" }),
}));

mock.module("@/db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findByNodeId: async (nodeId: string) => ({ node_id: nodeId }),
  },
}));

mock.module("@/lib/services/containers/node-autoscaler", () => ({
  getNodeAutoscaler: () => ({
    drainNode: async (nodeId: string, options: { deprovision: boolean }) => {
      drainCalls.push({ nodeId, options });
    },
  }),
}));

mock.module("@/lib/services/containers/hetzner-cloud-api", () => ({
  HetznerCloudError: class HetznerCloudError extends Error {},
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error() {},
  },
}));

const { default: drainRoute } = await import(
  "../v1/admin/docker-nodes/[nodeId]/drain/route"
);

const app = new Hono();
app.route("/api/v1/admin/docker-nodes/:nodeId/drain", drainRoute);

function request(body?: BodyInit): Request {
  return new Request(
    "http://cloud.test/api/v1/admin/docker-nodes/node-1/drain",
    {
      method: "POST",
      ...(body === undefined
        ? {}
        : { body, headers: { "content-type": "application/json" } }),
    },
  );
}

beforeEach(() => {
  drainCalls.length = 0;
});

describe("Docker-node drain request boundary", () => {
  test("rejects malformed JSON before disabling the node", async () => {
    const response = await app.fetch(request('{"deprovision":'));
    const payload = (await response.json()) as {
      success: boolean;
      error: string;
    };

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      success: false,
      error: "Invalid JSON body",
    });
    expect(drainCalls).toEqual([]);
  });

  test("preserves the body-optional disable operation", async () => {
    const response = await app.fetch(request());

    expect(response.status).toBe(200);
    expect(drainCalls).toEqual([
      { nodeId: "node-1", options: { deprovision: false } },
    ]);
  });

  test("forwards an explicit deprovision request", async () => {
    const response = await app.fetch(request('{"deprovision":true}'));

    expect(response.status).toBe(200);
    expect(drainCalls).toEqual([
      { nodeId: "node-1", options: { deprovision: true } },
    ]);
  });
});
