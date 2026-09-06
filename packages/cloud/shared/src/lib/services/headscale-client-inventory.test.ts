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

test.each([
  "stable",
  "rotated-before",
  "rotated-after",
  "inventory-redirect",
  "different-endpoint",
  "different-owner",
  "malformed-key",
  "redirect",
] as const)("scoped inventory rejects changed server authority (%s)", async (scenario) => {
  const originalKey = `mkey:${"1".repeat(64)}`;
  const replacementKey = `mkey:${"2".repeat(64)}`;
  let keyRequests = 0;
  let inventoryRequests = 0;
  let keyCredentialSent = false;
  let inventoryCredential: string | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/key" && url.search === "?v=39") {
        keyRequests++;
        keyCredentialSent ||= request.headers.has("authorization");
        if (scenario === "redirect" && keyRequests > 1)
          return new Response(null, { status: 302, headers: { location: "/different-service" } });
        if (scenario === "malformed-key" && keyRequests > 1)
          return Response.json({ publicKey: "unverified" });
        const rotated =
          scenario === "rotated-before"
            ? keyRequests > 1
            : scenario === "rotated-after" && keyRequests > 2;
        return Response.json({ publicKey: rotated ? replacementKey : originalKey });
      }
      if (url.pathname === "/api/v1/node") {
        inventoryRequests++;
        inventoryCredential = request.headers.get("authorization");
        if (scenario === "inventory-redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "/different-service" },
          });
        return Response.json({ nodes: [registeredNode] });
      }
      if (url.pathname === "/different-service") return Response.json({ nodes: [registeredNode] });
      return new Response("Unexpected route", { status: 404 });
    },
  });
  try {
    const client = new HeadscaleClient({
      apiUrl: `${server.url.origin}/`,
      user: "agent",
      apiKey: "initial-fixture",
    });
    const authority = await client.captureServerAuthority();
    const configured = new HeadscaleClient({
      apiUrl: server.url.origin,
      user: "agent",
      apiKey: "rotated-fixture",
    });
    const expected =
      scenario === "different-endpoint"
        ? { ...authority, apiUrl: "https://different.invalid" }
        : scenario === "different-owner"
          ? { ...authority, enrollmentUser: "production" }
          : authority;
    if (scenario === "stable") {
      expect(await configured.listNodesForAuthority(expected)).toEqual([registeredNode]);
      expect(inventoryCredential).toBe("Bearer rotated-fixture");
    } else {
      await expect(configured.listNodesForAuthority(expected)).rejects.toThrow();
      expect(inventoryRequests).toBe(
        scenario === "rotated-after" || scenario === "inventory-redirect" ? 1 : 0,
      );
      if (scenario === "different-endpoint" || scenario === "different-owner")
        expect(keyRequests).toBe(1);
    }
    expect(keyCredentialSent).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test.each([
  "deleted",
  "already-absent",
  "lost-ack",
  "still-present",
  "different-machine",
  "different-created-at",
  "duplicate-id",
  "malformed-id",
  "server-changed",
  "server-changed-after-delete",
] as const)(
  "node retirement requires exact registration and scoped readback (%s)",
  async (scenario) => {
    const originalServerKey = `mkey:${"3".repeat(64)}`;
    let serverKey = originalServerKey;
    const target = { ...registeredNode, machineKey: `mkey:${"4".repeat(64)}` };
    let nodes: unknown[] = [target];
    const deletedIds: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/key") return Response.json({ publicKey: serverKey });
        if (path === "/api/v1/node" && request.method === "GET") return Response.json({ nodes });
        if (request.method === "DELETE" && path === "/api/v1/node/17") {
          deletedIds.push("17");
          if (scenario !== "still-present") nodes = [];
          if (scenario === "server-changed-after-delete") serverKey = `mkey:${"5".repeat(64)}`;
          return scenario === "lost-ack" || scenario === "still-present"
            ? new Response("upstream acknowledgement unavailable", { status: 503 })
            : new Response(null, { status: 204 });
        }
        return new Response("Unexpected route", { status: 404 });
      },
    });
    try {
      const client = new HeadscaleClient({
        apiUrl: `${server.url.origin}/`,
        user: "agent",
        apiKey: "fixture",
      });
      const scope = await client.captureServerAuthority();
      const authority = await client.captureNodeAuthority(scope, target.id);
      if (scenario === "already-absent") nodes = [];
      if (scenario === "different-machine")
        nodes = [{ ...target, machineKey: `mkey:${"6".repeat(64)}` }];
      if (scenario === "different-created-at")
        nodes = [{ ...target, createdAt: "2026-09-02T00:00:00Z" }];
      if (scenario === "duplicate-id") nodes = [target, target];
      if (scenario === "malformed-id") nodes = [target, { id: "../17" }];
      if (scenario === "server-changed") serverKey = `mkey:${"5".repeat(64)}`;
      if (scenario === "deleted" || scenario === "already-absent" || scenario === "lost-ack") {
        const receipt = await client.deleteNodeForAuthority(authority);
        expect(receipt).toMatchObject({ state: "absent", authority });
        expect(nodes).toEqual([]);
        expect(deletedIds).toEqual(scenario === "already-absent" ? [] : ["17"]);
        await expect(client.deleteNodeForAuthority(authority)).resolves.toMatchObject({
          state: "absent",
          authority,
        });
        expect(deletedIds).toEqual(scenario === "already-absent" ? [] : ["17"]);
      } else {
        await expect(client.deleteNodeForAuthority(authority)).rejects.toThrow();
        expect(deletedIds).toEqual(
          scenario === "still-present" || scenario === "server-changed-after-delete" ? ["17"] : [],
        );
      }
    } finally {
      await server.stop(true);
    }
  },
);
