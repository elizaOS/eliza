/** Exercises strict Headscale inventory over a real loopback HTTP server with controlled upstream responses. */
import { expect, test } from "bun:test";
import { HeadscaleClient } from "./headscale-client";

const registeredNode = {
  id: "17",
  name: "retained-agent",
  user: { name: "agent" },
  ipAddresses: ["100.64.0.17"],
  online: false,
  createdAt: "2026-09-01T00:00:00Z",
  lastSeen: "2026-09-01T00:00:01Z",
};

test.each([
  { name: "explicit empty", body: { nodes: [] }, valid: true },
  { name: "registered node", body: { nodes: [registeredNode] }, valid: true },
  { name: "missing field", body: {}, valid: false },
  { name: "null envelope", body: null, valid: false },
  { name: "array envelope", body: [], valid: false },
  { name: "null inventory", body: { nodes: null }, valid: false },
  { name: "object inventory", body: { nodes: {} }, valid: false },
  { name: "unrelated response", body: { status: "healthy" }, valid: false },
])("strict inventory distinguishes $name from absence", async ({ body, valid }) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method !== "GET" || new URL(request.url).pathname !== "/api/v1/node")
        return new Response("Unexpected route", { status: 404 });
      return Response.json(body);
    },
  });
  try {
    const client = new HeadscaleClient({ apiUrl: server.url.origin, apiKey: "loopback-fixture" });
    if (valid) {
      const nodes = await client.listNodesStrict();
      expect(nodes).toEqual(body && "nodes" in body ? body.nodes : undefined);
    } else {
      await expect(client.listNodesStrict()).rejects.toMatchObject({
        code: "HEADSCALE_NODE_INVENTORY_INVALID",
      });
    }
  } finally {
    await server.stop(true);
  }
});

test.each([200, 403, 503])(
  "strict inventory never treats HTTP %s HTML as absence",
  async (status) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<html>Gateway response</html>", {
          status,
          headers: { "Content-Type": "text/html" },
        }),
    });
    try {
      const client = new HeadscaleClient({ apiUrl: server.url.origin, apiKey: "loopback-fixture" });
      await expect(client.listNodesStrict()).rejects.toMatchObject(
        status === 200 ? { code: "HEADSCALE_NODE_INVENTORY_INVALID" } : { status },
      );
    } finally {
      await server.stop(true);
    }
  },
);
