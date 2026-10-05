/** Real agent registry and authenticated status HTTP with controlled loader lifecycle; no inference or external calls. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  type IAgentRuntime,
  ModelType,
  Service,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { installRouterHandler } from "../../../plugins/plugin-local-inference/src/services/router-handler.ts";
import { detectRuntimeModel } from "../src/api/agent-model.ts";
import {
  type CloudModelReadinessView,
  computeCanRespond,
  responseReadinessFields,
} from "../src/api/health-routes.ts";
import { startApiServer } from "../src/api/server.ts";

class Loader extends Service {
  static serviceType = "localInferenceLoader";
  capabilityDescription = "Controlled loader lifecycle for status acceptance";
  path: string | null = null;
  currentModelPath() {
    return this.path;
  }
  async loadModel() {
    throw new Error("Status must not load weights");
  }
  async unloadModel() {
    throw new Error("Status must not unload weights");
  }
  static async start(runtime: IAgentRuntime) {
    return new Loader(runtime);
  }
  async stop() {}
}
class CloudRegistry extends Service {
  static serviceType = "CLOUD_MODEL_REGISTRY";
  capabilityDescription = "Controlled cached catalog result";
  readiness: CloudModelReadinessView = {
    status: "unknown",
    reason: "catalog unavailable",
    checkedAt: null,
  };
  getTextModelReadiness() {
    return this.readiness;
  }
  static async start(runtime: IAgentRuntime) {
    return new CloudRegistry(runtime);
  }
  async stop() {}
}
const noInference = async () => {
  throw new Error("Status must never invoke inference");
};
/** Install the production router; readiness must not invoke its handlers. */
function registerLocalRouter(target: AgentRuntime) {
  installRouterHandler(target);
}
let runtime: AgentRuntime;
let directory: string;
let server: Awaited<ReturnType<typeof startApiServer>>;
let loader: Loader;
const token = randomUUID();
beforeAll(async () => {
  vi.stubEnv("ELIZA_API_TOKEN", token);
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
  directory = await mkdtemp(join(tmpdir(), "local-model-readiness-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  runtime = new AgentRuntime({
    character: { name: "Local readiness", bio: [] },
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "agent.sqlite"),
      runtime.agentId,
    ),
  );
  await runtime.registerPlugin({
    name: "google-workspace",
    description: "Connector without text handlers",
  });
  await runtime.registerPlugin({
    name: "eliza-local-inference",
    description: "Unloaded local handler",
    models: { [ModelType.TEXT_LARGE]: noInference },
    services: [Loader],
  });
  await runtime.initialize({ skipMigrations: true });
  // The real plugin also fronts its text slots with the prefer-local router
  // (plugin-local-inference router-handler.ts `installRouterHandler`).
  registerLocalRouter(runtime);
  await runtime.getServiceLoadPromise(Loader.serviceType);
  const service = runtime.getService<Loader>(Loader.serviceType);
  if (!service) throw new Error("Loader did not initialize");
  loader = service;
  server = await startApiServer({
    port: 0,
    runtime,
    skipDeferredStartupWork: true,
  });
}, 120_000);
afterAll(async () => {
  if (server) await server.close();
  if (runtime) await runtime.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
}, 120_000);

it("reports local load/unload through authenticated HTTP and does not label a connector as a model", async () => {
  const status = async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await status()).toMatchObject({
    canRespond: false,
    localModelReadiness: {
      provider: "eliza-local-inference",
      status: "model_not_loaded",
    },
  });
  expect(detectRuntimeModel(runtime)).not.toBe("google-workspace");
  loader.path = "/isolated-test/model.gguf";
  expect((await status()).canRespond).toBe(true);
  const other = new AgentRuntime({
    character: { name: "Other agent", bio: [] },
  });
  other.registerModel(
    ModelType.TEXT_LARGE,
    noInference,
    "eliza-local-inference",
  );
  expect((await responseReadinessFields(other, "running")).canRespond).toBe(
    false,
  );
  loader.path = null;
  expect((await status()).canRespond).toBe(false);
});

it("reports the actual local router and a remote fallback through authenticated HTTP", async () => {
  const routed = new AgentRuntime({
    character: { name: "Routed local", bio: [] },
  });
  routed.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "routed.sqlite"),
      routed.agentId,
    ),
  );
  routed.registerModel(
    ModelType.TEXT_LARGE,
    noInference,
    "eliza-local-inference",
  );
  await routed.initialize({ skipMigrations: true });
  registerLocalRouter(routed);
  let routedServer: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    routedServer = await startApiServer({
      port: 0,
      runtime: routed,
      skipDeferredStartupWork: true,
    });
    const status = async () => {
      const response = await fetch(
        `http://127.0.0.1:${routedServer?.port}/api/status`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await status()).toMatchObject({
      canRespond: false,
      localModelReadiness: {
        provider: "eliza-local-inference",
        status: "model_not_loaded",
      },
    });
    // Registration readiness is not a claim of external provider availability.
    routed.registerModel(ModelType.TEXT_LARGE, noInference, "openai");
    const mixed = await status();
    expect(mixed.canRespond).toBe(true);
    expect(mixed.localModelReadiness).toBeNull();
  } finally {
    if (routedServer) await routedServer.close();
    await routed.stop();
  }
}, 120_000);

it.each(["custom-provider", "ollama", "openai", "elizaOSCloud"])(
  "preserves mixed and independent %s providers",
  (provider) => {
    const runtime = new AgentRuntime({
      character: { name: provider, bio: [] },
    });
    runtime.registerModel(ModelType.TEXT_LARGE, noInference, provider);
    expect(computeCanRespond(runtime, "running", null)).toBe(true);
    runtime.registerModel(
      ModelType.TEXT_SMALL,
      noInference,
      "eliza-local-inference",
    );
    expect(computeCanRespond(runtime, "running", null)).toBe(true);
    expect(computeCanRespond(runtime, "stopped", null)).toBe(false);
  },
);

it("preserves Cloud unknown, explicit unavailable, and fallback-provider behavior", async () => {
  // A separate real registry avoids the local fallback registered by the HTTP fixture.
  const cloud = new AgentRuntime({
    character: { name: "Cloud only", bio: [] },
  });
  cloud.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "cloud.sqlite"),
      cloud.agentId,
    ),
  );
  await cloud.initialize({ skipMigrations: true });
  cloud.registerModel(ModelType.TEXT_LARGE, noInference, "elizaOSCloud");
  await cloud.registerService(CloudRegistry);
  await cloud.getServiceLoadPromise(CloudRegistry.serviceType);
  const cloudRegistry = cloud.getService<CloudRegistry>(
    CloudRegistry.serviceType,
  );
  if (!cloudRegistry) throw new Error("Cloud registry did not start");
  expect(computeCanRespond(cloud, "running", null)).toBe(true);
  cloudRegistry.readiness = {
    status: "model_not_available",
    code: "MODEL_NOT_AVAILABLE",
    missing: [{ modelType: "TEXT_LARGE", modelId: "missing", configKey: null }],
    message: "Model missing",
    checkedAt: Date.now(),
  };
  expect(computeCanRespond(cloud, "running", null)).toBe(false);
  cloud.registerModel(ModelType.TEXT_LARGE, noInference, "custom-fallback");
  expect(computeCanRespond(cloud, "running", null)).toBe(true);
  await cloud.stop();
});

it("includes the local readiness reason on initial and periodic WebSocket status", async () => {
  loader.path = null;
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  try {
    const statuses: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Missing initial and periodic status")),
        15_000,
      );
      ws.on("error", reject);
      ws.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type !== "status") return;
        statuses.push(event);
        if (statuses.length === 2) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    for (const status of statuses)
      expect(status).toMatchObject({
        canRespond: false,
        localModelReadiness: {
          provider: "eliza-local-inference",
          status: "model_not_loaded",
        },
      });
  } finally {
    ws.close();
  }
}, 20_000);
