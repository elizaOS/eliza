/** Exercises actual HTTP delivery to separate health and bridge listeners through the production sandbox transport. */
import { expect, test } from "bun:test";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { ElizaSandboxService } from "./eliza-sandbox";
import { SandboxTransport } from "./eliza-sandbox/bridge/transport";

test("snapshot reaches the authenticated bridge while health reaches the web listener", async () => {
  const received: string[] = [];
  const web = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      received.push("web:" + new URL(request.url).pathname);
      return new URL(request.url).pathname === "/health"
        ? Response.json({ ready: true })
        : new Response("Not Found", { status: 404 });
    },
  });
  const state = {
    memories: [{ text: "complete preserved fixture state" }],
    config: { name: "owned" },
    workspaceFiles: { "proof.txt": "full bytes" },
  };
  const bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      received.push("bridge:" + new URL(request.url).pathname);
      if (request.headers.get("authorization") !== "Bearer synthetic-test-token")
        return new Response("Unauthorized", { status: 401 });
      return Response.json(state);
    },
  });
  let foreignRequests = 0;
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      foreignRequests += 1;
      return new Response("foreign");
    },
  });
  try {
    const rec = {
      id: "a4a55512-29e6-4674-a0fe-49b1e5bc946c",
      node_id: "owned-node",
      headscale_ip: "127.0.0.1",
      web_ui_port: web.port,
      bridge_port: bridge.port,
      health_url: web.url.toString(),
      bridge_url: null,
      sandbox_id: "owned",
      environment_vars: { ELIZA_API_TOKEN: "synthetic-test-token" },
    };
    await runWithCloudBindings({ ELIZA_CLOUD_AGENT_BASE_DOMAIN: "" }, async () => {
      const transport = new SandboxTransport();
      for (const path of [
        foreign.url.toString() + "api/snapshot",
        `//127.0.0.1:${foreign.port}/api/snapshot`,
        `/x/..//127.0.0.1:${foreign.port}/api/snapshot`,
      ]) {
        await expect(transport.fetchAgentApi(rec, path)).rejects.toMatchObject({
          code: "AGENT_API_PATH_ORIGIN_MISMATCH",
        });
      }
      expect(foreignRequests).toBe(0);
      const response = await transport.fetchAgentApi(rec, "/api/snapshot", { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(state);
      expect(await (await transport.fetchAgentApi(rec, "/health")).json()).toEqual({ ready: true });
      expect(received).toEqual(["bridge:/api/snapshot", "web:/health"]);
      await expect(
        transport.fetchAgentApi({ ...rec, environment_vars: {} }, "/api/snapshot"),
      ).rejects.toThrow("requires an API token");
      expect(received).toEqual(["bridge:/api/snapshot", "web:/health"]);
      await runWithCloudBindings({ ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai" }, async () => {
        const target = await transport.getAgentApiFetchTarget(
          { ...rec, node_id: null, bridge_port: null },
          "/api/snapshot?version=1",
        );
        expect(target.url).toBe(`https://${rec.id}.elizacloud.ai/api/snapshot?version=1`);
      });
      await expect(
        transport.getAgentApiFetchTarget(
          {
            ...rec,
            node_id: null,
            bridge_port: null,
            bridge_url: "http://169.254.169.254/latest/meta-data",
          },
          "/api/snapshot",
        ),
      ).rejects.toThrow();
      expect(received).toEqual(["bridge:/api/snapshot", "web:/health"]);
    });
  } finally {
    foreign.stop(true);
    web.stop(true);
    bridge.stop(true);
  }
});

test("an unreadable runtime-agent list cannot trigger agent creation", async () => {
  let createRequests = 0;
  const bridge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/agents") {
        return new Response("upstream gateway returned HTML", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (request.method === "POST" && url.pathname === "/api/agents") {
        createRequests += 1;
        return Response.json({ data: { id: "duplicate-agent" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const record = {
      id: "a4a55512-29e6-4674-a0fe-49b1e5bc946c",
      agent_name: "Existing Agent",
      agent_config: { name: "Existing Agent" },
      node_id: "owned-node",
      headscale_ip: "127.0.0.1",
      web_ui_port: bridge.port,
      bridge_port: bridge.port,
      health_url: `${bridge.url}health`,
      bridge_url: null,
      sandbox_id: "owned",
      organization_id: "8f66509d-8d9a-4ed8-a535-9f54fe5f763a",
      user_id: null,
      environment_vars: { ELIZA_API_TOKEN: "synthetic-test-token" },
    };
    const service = new ElizaSandboxService() as unknown as {
      ensureRuntimeAgentStarted(value: typeof record): Promise<unknown>;
    };

    await runWithCloudBindings({ ELIZA_CLOUD_AGENT_BASE_DOMAIN: "" }, async () => {
      await expect(service.ensureRuntimeAgentStarted(record)).rejects.toThrow(
        "Runtime agent list response was not valid JSON",
      );
    });
    expect(createRequests).toBe(0);
  } finally {
    bridge.stop(true);
  }
});
