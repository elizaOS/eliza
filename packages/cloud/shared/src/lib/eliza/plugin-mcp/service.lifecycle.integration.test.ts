import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { type Action, ElizaError, type IAgentRuntime, stringToUuid } from "@elizaos/core";
import { McpService } from "./service";

const schemaCacheEnabled = process.env.MCP_SCHEMA_CACHE_ENABLED;
beforeAll(() => {
  process.env.MCP_SCHEMA_CACHE_ENABLED = "false";
});
afterAll(() => {
  if (schemaCacheEnabled === undefined) delete process.env.MCP_SCHEMA_CACHE_ENABLED;
  else process.env.MCP_SCHEMA_CACHE_ENABLED = schemaCacheEnabled;
});

function peer(holdResourcesAt?: number) {
  const methods: string[] = [];
  let resourceRequests = 0;
  const resourcesRequested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const rpc = (await request.json()) as {
        id?: number | string;
        method: string;
        params?: { protocolVersion?: string };
      };
      methods.push(rpc.method);
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: object) => Response.json({ jsonrpc: "2.0", id: rpc.id, result });
      switch (rpc.method) {
        case "initialize":
          return reply({
            protocolVersion: rpc.params?.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "lifecycle-peer", version: "1" },
          });
        case "tools/list":
          return reply({
            tools: [{ name: "echo", description: "Local tool", inputSchema: { type: "object" } }],
          });
        case "resources/list":
          resourceRequests++;
          if (resourceRequests === holdResourcesAt) {
            resourcesRequested.resolve();
            await release.promise;
          }
          return reply({ resources: [] });
        case "resources/templates/list":
          return reply({ resourceTemplates: [] });
        default:
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32601, message: "Unexpected fixture method" },
          });
      }
    },
  });
  return {
    server,
    methods,
    resourcesRequested: resourcesRequested.promise,
    release: release.resolve,
  };
}

function runtimeFor(url: URL) {
  const actions: Action[] = [];
  const publications: string[] = [];
  const runtime = {
    agentId: stringToUuid("mcp-lifecycle-agent"),
    actions,
    getSetting: (name: string) =>
      name === "mcp"
        ? { servers: { peer: { type: "streamable-http", url: url.toString() } } }
        : null,
    registerAction(action: Action) {
      publications.push(action.name);
      actions.push(action);
    },
  } as unknown as IAgentRuntime;
  return { runtime, actions, publications };
}

test("stopping a disconnected HTTP session retires its lazy tool actions", async () => {
  const remote = peer();
  const { runtime, actions } = runtimeFor(remote.server.url);
  const service = await McpService.start(runtime);
  try {
    await service.waitForInitialization();
    expect(service.getServers()).toEqual([]);
    expect(service.isLazyConnection("peer")).toBe(true);
    expect(actions).toHaveLength(1);
    expect(service.getRegisteredActions().map((action) => action._mcpMeta.toolName)).toEqual([
      "echo",
    ]);
    expect(remote.methods).toContain("resources/templates/list");

    await service.stop();
    expect({
      lazy: service.isLazyConnection("peer"),
      actions: actions.map((action) => action.name),
      registered: service.getRegisteredActions().map((action) => action.name),
    }).toEqual({ lazy: false, actions: [], registered: [] });
  } finally {
    await service.stop();
    await remote.server.stop(true);
  }
}, 15_000);

test("stopping during real HTTP discovery prevents late tool publication", async () => {
  const remote = peer(1);
  const { runtime, actions, publications } = runtimeFor(remote.server.url);
  const service = new McpService(runtime);
  try {
    await Promise.race([
      remote.resourcesRequested,
      service.waitForInitialization().then(() => {
        throw new Error("Discovery completed before the held resource request");
      }),
    ]);
    expect(remote.methods).toContain("tools/list");
    expect(actions).toHaveLength(0);
    await service.stop();
    remote.release();
    await service.waitForInitialization();

    expect({
      lazy: service.isLazyConnection("peer"),
      actions: actions.map((action) => action.name),
      published: publications,
      servers: service.getServers().map((server) => server.name),
      templatesRequested: remote.methods.includes("resources/templates/list"),
    }).toEqual({ lazy: false, actions: [], published: [], servers: [], templatesRequested: false });
  } finally {
    remote.release();
    await service.stop();
    await remote.server.stop(true);
  }
}, 15_000);

test("stop fences lazy publication after temporary HTTP transport close", async () => {
  const remote = peer();
  const { runtime, actions, publications } = runtimeFor(remote.server.url);
  const service = new McpService(runtime);
  const closed = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const disconnect = service.disconnect.bind(service);
  const hold = spyOn(service, "disconnect").mockImplementation(async (name) => {
    // Hold the continuation after the real SDK transport and client close.
    await disconnect(name);
    closed.resolve();
    await resume.promise;
  });
  try {
    await Promise.race([
      closed.promise,
      service.waitForInitialization().then(() => {
        throw new Error("Discovery completed before the temporary transport closed");
      }),
    ]);
    expect(remote.methods).toContain("resources/templates/list");
    expect(service.getServers()).toEqual([]);
    expect(actions).toHaveLength(0);
    expect(publications).toHaveLength(1);
    await service.stop();
    resume.resolve();
    await service.waitForInitialization();
    expect({
      lazy: service.isLazyConnection("peer"),
      actions: actions.map((action) => action.name),
      published: publications.length,
    }).toEqual({ lazy: false, actions: [], published: 1 });
  } finally {
    resume.resolve();
    hold.mockRestore();
    await service.stop();
    await remote.server.stop(true);
  }
}, 15_000);

test("stopping a lazy server preserves a replacement runtime action with the same name", async () => {
  const remote = peer();
  const { runtime, actions } = runtimeFor(remote.server.url);
  const service = await McpService.start(runtime);
  try {
    await service.waitForInitialization();
    expect(actions).toHaveLength(1);
    const replacement = { ...actions[0]!, description: "Replacement runtime action" };
    actions.splice(0, 1, replacement);

    await service.stop();
    expect(actions).toEqual([replacement]);
    expect(service.getRegisteredActions()).toEqual([]);
  } finally {
    await service.stop();
    await remote.server.stop(true);
  }
}, 15_000);

test("stopping a started service rejects a pending lazy HTTP connection", async () => {
  const remote = peer(2);
  const { runtime, actions, publications } = runtimeFor(remote.server.url);
  const service = await McpService.start(runtime);
  try {
    expect(service.isLazyConnection("peer")).toBe(true);
    const published = publications.length;
    const opened = service.ensureConnected("peer").then(
      () => "connected",
      (error: unknown) => (error instanceof ElizaError ? error.code : String(error)),
    );
    await Promise.race([
      remote.resourcesRequested,
      opened.then(() => {
        throw new Error("Lazy connection settled before the held resource request");
      }),
    ]);
    await service.stop();
    remote.release();
    expect({
      outcome: await opened,
      published: publications.length,
      actions: actions.map((action) => action.name),
      lazy: service.isLazyConnection("peer"),
    }).toEqual({ outcome: "MCP_SERVICE_STOPPED", published, actions: [], lazy: false });
  } finally {
    remote.release();
    await service.stop();
    await remote.server.stop(true);
  }
}, 15_000);
