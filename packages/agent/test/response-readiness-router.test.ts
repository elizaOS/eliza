/** Real runtimes with the production local-inference router installed; checks `canRespond` against what a turn would do, with no inference or external calls. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  type IAgentRuntime,
  ModelType,
  NoModelProviderConfiguredError,
  Service,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { installRouterHandler } from "../../../plugins/plugin-local-inference/src/services/router-handler.ts";
import {
  type CloudModelReadinessView,
  computeCanRespond,
  responseReadinessFields,
} from "../src/api/health-routes.ts";

class CloudRegistry extends Service {
  static serviceType = "CLOUD_MODEL_REGISTRY";
  capabilityDescription = "Controlled cached catalog result";
  readiness: CloudModelReadinessView = {
    status: "available",
    checkedAt: Date.now(),
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
  throw new Error("Readiness must never invoke inference");
};
const missingLargeModel: CloudModelReadinessView = {
  status: "model_not_available",
  code: "MODEL_NOT_AVAILABLE",
  missing: [{ modelType: "TEXT_LARGE", modelId: "missing", configKey: null }],
  message: "Model missing",
  checkedAt: Date.now(),
};
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "response-readiness-router-"));
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function initializedRuntime(name: string): Promise<AgentRuntime> {
  const runtime = new AgentRuntime({ character: { name, bio: [] } });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, `${name.replace(/\W+/g, "-")}.sqlite`),
      runtime.agentId,
    ),
  );
  await runtime.initialize({ skipMigrations: true });
  return runtime;
}

it("does not report a router with no provider behind it as able to respond", async () => {
  // A device-bridge host waiting for a device installs the router before any
  // text handler exists (ensure-local-inference-handler.ts); the router is the
  // only registration on every text slot.
  const runtime = new AgentRuntime({
    character: { name: "Router only", bio: [] },
  });
  installRouterHandler(runtime);
  const textRows = runtime
    .getModelRegistrations()
    .filter((entry) => entry.modelType === ModelType.TEXT_LARGE);
  expect(textRows.map((entry) => entry.provider)).toEqual(["eliza-router"]);

  await expect(
    runtime.useModel(ModelType.TEXT_LARGE, { prompt: "first turn" }),
  ).rejects.toBeInstanceOf(NoModelProviderConfiguredError);
  expect(computeCanRespond(runtime, "running", null)).toBe(false);
  expect(await responseReadinessFields(runtime, "running")).toMatchObject({
    canRespond: false,
    localModelReadiness: null,
  });

  runtime.registerModel(ModelType.TEXT_LARGE, noInference, "openai");
  expect(computeCanRespond(runtime, "running", null)).toBe(true);
});

it("gates a Cloud-only runtime behind the router when the catalog lacks the model", async () => {
  const runtime = await initializedRuntime("Router over Cloud");
  try {
    runtime.registerModel(ModelType.TEXT_LARGE, noInference, "elizaOSCloud");
    installRouterHandler(runtime);
    await runtime.registerService(CloudRegistry);
    await runtime.getServiceLoadPromise(CloudRegistry.serviceType);
    const registry = runtime.getService<CloudRegistry>(
      CloudRegistry.serviceType,
    );
    if (!registry) throw new Error("Cloud registry did not start");

    expect(computeCanRespond(runtime, "running", null)).toBe(true);
    registry.readiness = missingLargeModel;
    // The router can only dispatch to Cloud here, so it is not a failover.
    expect(computeCanRespond(runtime, "running", null)).toBe(false);

    runtime.registerModel(ModelType.TEXT_LARGE, noInference, "custom-fallback");
    expect(computeCanRespond(runtime, "running", null)).toBe(true);
  } finally {
    await runtime.stop();
  }
});

it.each(["custom-provider", "ollama", "openai", "elizaOSCloud"])(
  "keeps a %s handler behind the router respondable",
  (provider) => {
    const runtime = new AgentRuntime({
      character: { name: `Router over ${provider}`, bio: [] },
    });
    runtime.registerModel(ModelType.TEXT_LARGE, noInference, provider);
    installRouterHandler(runtime);
    expect(computeCanRespond(runtime, "running", null)).toBe(true);
    expect(computeCanRespond(runtime, "stopped", null)).toBe(false);
  },
);

it("reports an unreadable model inventory instead of reading it as no providers", async () => {
  // The catalog answered positively (the configured Cloud model is not listed)
  // and the only thing left to learn is whether another provider could serve
  // it. A thrown inventory read leaves that unanswered, so the permissive
  // verdict stays (#30228) — but collapsing the throw into `[]` makes a
  // registry that refuses to answer look exactly like a runtime with no
  // registrations, and nothing on the status path shows the difference.
  const runtime = await initializedRuntime("Cloud inventory fault");
  const original = runtime.getModelRegistrations.bind(runtime);
  try {
    runtime.registerModel(ModelType.TEXT_LARGE, noInference, "elizaOSCloud");
    await runtime.registerService(CloudRegistry);
    await runtime.getServiceLoadPromise(CloudRegistry.serviceType);
    const registry = runtime.getService<CloudRegistry>(
      CloudRegistry.serviceType,
    );
    if (!registry) throw new Error("Cloud registry did not start");
    expect(computeCanRespond(runtime, "running", null)).toBe(true);

    const warnings: Array<{ context: unknown; message: unknown }> = [];
    const logger = runtime.logger as unknown as {
      warn: (context: unknown, message: unknown) => void;
    };
    logger.warn = (context: unknown, message: unknown) => {
      warnings.push({ context, message });
    };
    let inventoryFault = false;
    runtime.getModelRegistrations = () => {
      if (inventoryFault) throw new Error("model registry unavailable");
      return original();
    };
    // Arm the fault only once the catalog has answered, so the capability
    // probe itself still completes and reaches the inventory read.
    registry.getTextModelReadiness = () => {
      inventoryFault = true;
      return missingLargeModel;
    };

    expect(computeCanRespond(runtime, "running", null)).toBe(true);
    expect(warnings).toEqual([
      {
        context: {
          src: "health-routes",
          error: "model registry unavailable",
        },
        message: "Cloud model inventory unavailable",
      },
    ]);
  } finally {
    runtime.getModelRegistrations = original;
    await runtime.stop();
  }
});
