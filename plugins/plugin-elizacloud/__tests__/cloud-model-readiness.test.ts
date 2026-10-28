/**
 * Cloud text-model readiness (#30228): the registry validates the effective
 * TEXT_SMALL / TEXT_LARGE ids against the real `/models` catalog served over
 * HTTP, reports a stale override as MODEL_NOT_AVAILABLE naming the setting,
 * and keeps catalog outages `unknown` (retryable) instead of gating chat.
 */
import * as http from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import {
  DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
} from "@elizaos/host/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloudAuthService } from "../src/services/cloud-auth";
import { evaluateCloudTextModelReadiness } from "../src/services/cloud-model-readiness";
import { CloudModelRegistryService } from "../src/services/cloud-model-registry";

let server: http.Server;
let baseUrl: string;
let catalog: { status: number; ids: string[]; entries?: Array<{ id: string; owned_by?: string }> };
let modelRequests = 0;
let unexpectedRequests: string[] = [];

function runtimeWith(settings: Record<string, string>): IAgentRuntime {
  const auth = new CloudAuthService();
  auth.getClient().setBaseUrl(baseUrl);
  auth.authenticateWithApiKey({ apiKey: "test-key" });
  const runtime = {
    getService: (name: string) => (name === "CLOUD_AUTH" ? auth : null),
    getSetting: (key: string) => settings[key] ?? null,
  };
  return runtime as unknown as IAgentRuntime;
}

async function startRegistry(settings: Record<string, string>) {
  return (await CloudModelRegistryService.start(
    runtimeWith(settings)
  )) as CloudModelRegistryService;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method !== "GET" || !req.url?.endsWith("/models"))
      unexpectedRequests.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith("/models")) modelRequests += 1;
    res.writeHead(catalog.status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        catalog.status === 200
          ? {
              object: "list",
              data:
                catalog.entries ??
                catalog.ids.map((id) => ({
                  id,
                  object: "model",
                  created: 1,
                  owned_by: id.startsWith("openai/") ? "openai" : "cerebras",
                })),
            }
          : { success: false, error: `HTTP ${catalog.status}` }
      )
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no AddressInfo");
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

afterEach(() => {
  expect(unexpectedRequests).toEqual([]);
});
beforeEach(() => {
  unexpectedRequests = [];
  modelRequests = 0;
  catalog = {
    status: 200,
    ids: [
      DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
      DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
      "openai/listed-large",
    ],
  };
});

describe("CloudModelRegistryService.getTextModelReadiness", () => {
  it("default models listed in the catalog are available", async () => {
    const registry = await startRegistry({});
    expect(registry.getTextModelReadiness()).toMatchObject({ status: "available" });
  });

  it("a valid configured override (matched by provider-stripped name) is available", async () => {
    const registry = await startRegistry({ ELIZAOS_CLOUD_LARGE_MODEL: "listed-large" });
    expect(registry.getTextModelReadiness().status).toBe("available");
  });

  it("a stale configured override is MODEL_NOT_AVAILABLE naming the setting and id", async () => {
    const registry = await startRegistry({ ELIZAOS_CLOUD_LARGE_MODEL: "retired-model-9000" });
    const readiness = registry.getTextModelReadiness();
    expect(readiness).toMatchObject({
      status: "model_not_available",
      code: "MODEL_NOT_AVAILABLE",
      missing: [
        {
          modelType: "TEXT_LARGE",
          configKey: "ELIZAOS_CLOUD_LARGE_MODEL",
          modelId: "retired-model-9000",
        },
      ],
    });
    if (readiness.status !== "model_not_available") throw new Error("unreachable");
    expect(readiness.message).toContain("ELIZAOS_CLOUD_LARGE_MODEL");
  });

  it("a catalog outage is unknown (retryable), never model_not_available", async () => {
    catalog.status = 503;
    const registry = await startRegistry({ ELIZAOS_CLOUD_LARGE_MODEL: "retired-model-9000" });
    expect(registry.getTextModelReadiness()).toMatchObject({
      status: "unknown",
      reason: "catalog_unavailable",
    });
  });

  it("reading readiness repeatedly does not refetch a fresh catalog", async () => {
    const registry = await startRegistry({});
    const afterStart = modelRequests;
    for (let i = 0; i < 5; i += 1) registry.getTextModelReadiness();
    expect(modelRequests).toBe(afterStart);
  });
});

describe("provider-bound catalog transport identities", () => {
  const pinned = "cerebras/qwen-3.8-27b";
  const settings = () => ({ ELIZAOS_CLOUD_SMALL_MODEL: pinned, ELIZAOS_CLOUD_LARGE_MODEL: pinned });
  it("accepts the literal public catalog id when another provider has the same model name", async () => {
    catalog.entries = [
      { id: "gpt-oss-120b", owned_by: "cerebras" },
      { id: "openai/gpt-oss-120b", owned_by: "openai" },
    ];
    const selected = {
      ELIZAOS_CLOUD_SMALL_MODEL: "gpt-oss-120b",
      ELIZAOS_CLOUD_LARGE_MODEL: "gpt-oss-120b",
    };
    const original = { ...selected };
    const registry = await startRegistry(selected);
    expect(registry.getTextModelReadiness().status).toBe("available");
    expect(selected).toEqual(original);
    expect(modelRequests).toBe(1);
  });
  it("accepts the actual public bare and colon Cerebras entries for the unchanged native slash binding", async () => {
    catalog.entries = [
      { id: "qwen-3.8-27b", owned_by: "cerebras" },
      { id: "cerebras:qwen-3.8-27b", owned_by: "cerebras" },
    ];
    const selected = settings();
    const original = { ...selected };
    const registry = await startRegistry(selected);
    expect(registry.getTextModelReadiness().status).toBe("available");
    expect(await registry.getAvailableModels()).toMatchObject([
      { id: "qwen-3.8-27b", provider: "cerebras", name: "qwen-3.8-27b" },
      { id: "cerebras:qwen-3.8-27b", provider: "cerebras", name: "qwen-3.8-27b" },
    ]);
    expect(selected).toEqual(original);
    expect(modelRequests).toBe(1);
  });
  it("never treats a bare same-name model owned by another provider as Cerebras", async () => {
    catalog.entries = [{ id: "qwen-3.8-27b", owned_by: "openai" }];
    const registry = await startRegistry(settings());
    const state = registry.getTextModelReadiness();
    expect(state.status).toBe("model_not_available");
    if (state.status === "model_not_available") expect(state.missing).toHaveLength(2);
  });
  it("rejects an id prefix refuted by explicit owned_by even when the literal id matches", async () => {
    catalog.entries = [{ id: pinned, owned_by: "openai" }];
    const registry = await startRegistry(settings());
    expect(registry.getTextModelReadiness().status).toBe("model_not_available");
  });
  it("does not resolve an ambiguous bare model name across providers", async () => {
    catalog.entries = [
      { id: "cerebras/shared-name", owned_by: "cerebras" },
      { id: "openai/shared-name", owned_by: "openai" },
    ];
    const registry = await startRegistry({
      ELIZAOS_CLOUD_SMALL_MODEL: "shared-name",
      ELIZAOS_CLOUD_LARGE_MODEL: "shared-name",
    });
    expect(registry.getTextModelReadiness().status).toBe("model_not_available");
  });
  it("preserves nested model-name slashes without changing the requested provider", async () => {
    catalog.entries = [{ id: "openai/organization/model-name", owned_by: "openai" }];
    const registry = await startRegistry({
      ELIZAOS_CLOUD_SMALL_MODEL: "openai/organization/model-name",
      ELIZAOS_CLOUD_LARGE_MODEL: "openai/organization/model-name",
    });
    expect(registry.getTextModelReadiness().status).toBe("available");
    expect((await registry.getAvailableModels())[0].name).toBe("organization/model-name");
  });
  it.each(["cerebras//qwen-3.8-27b", "unknown/qwen-3.8-27b"])(
    "does not accept malformed or unknown catalog identity %s",
    async (id) => {
      catalog.entries = [{ id, owned_by: id.startsWith("unknown/") ? "unknown" : "cerebras" }];
      const registry = await startRegistry({
        ELIZAOS_CLOUD_SMALL_MODEL: id,
        ELIZAOS_CLOUD_LARGE_MODEL: id,
      });
      expect(registry.getTextModelReadiness().status).toBe("model_not_available");
    }
  );
  it("preserves both effective setting precedences without rewriting configuration", async () => {
    catalog.entries = [{ id: pinned, owned_by: "cerebras" }];
    const selected = {
      ...settings(),
      SMALL_MODEL: "retired-ignored-small",
      LARGE_MODEL: "retired-ignored-large",
    };
    const copy = { ...selected };
    const registry = await startRegistry(selected);
    expect(registry.getTextModelReadiness().status).toBe("available");
    expect(selected).toEqual(copy);
  });
  it("does not collapse a distinct free routing variant into the admitted paid model", async () => {
    catalog.entries = [{ id: "qwen-3.8-27b", owned_by: "cerebras" }];
    const registry = await startRegistry({
      ELIZAOS_CLOUD_SMALL_MODEL: `${pinned}:free`,
      ELIZAOS_CLOUD_LARGE_MODEL: `${pinned}:free`,
    });
    expect(registry.getTextModelReadiness().status).toBe("model_not_available");
  });
});

describe("catalog identity evidence boundaries", () => {
  const pinned = "cerebras/qwen-3.8-27b";
  const selected = { ELIZAOS_CLOUD_SMALL_MODEL: pinned, ELIZAOS_CLOUD_LARGE_MODEL: pinned };
  it("accepts a positive Cerebras colon-only advertisement for the unchanged slash transport", async () => {
    catalog.entries = [{ id: "cerebras:qwen-3.8-27b", owned_by: "cerebras" }];
    const registry = await startRegistry(selected);
    expect(registry.getTextModelReadiness().status).toBe("available");
  });
  it("does not invent Cerebras ownership for an unbound bare advertisement", async () => {
    catalog.entries = [{ id: "qwen-3.8-27b" }];
    const registry = await startRegistry(selected);
    expect(registry.getTextModelReadiness().status).toBe("model_not_available");
  });
  it("rejects a literal bare-name collision between positively distinct owners", async () => {
    catalog.entries = [
      { id: "shared-name", owned_by: "cerebras" },
      { id: "shared-name", owned_by: "openai" },
    ];
    const registry = await startRegistry({
      ELIZAOS_CLOUD_SMALL_MODEL: "shared-name",
      ELIZAOS_CLOUD_LARGE_MODEL: "shared-name",
    });
    expect(registry.getTextModelReadiness().status).toBe("model_not_available");
  });
  it("keeps an empty catalog unknown rather than available or permanently missing", async () => {
    catalog.ids = [];
    const registry = await startRegistry(selected);
    expect(registry.getTextModelReadiness()).toMatchObject({
      status: "unknown",
      reason: "catalog_empty",
    });
  });
  it("does not admit a truly absent model from another positive model on the same provider", async () => {
    catalog.entries = [{ id: "qwen-3.8-27b", owned_by: "cerebras" }];
    const registry = await startRegistry({
      ELIZAOS_CLOUD_SMALL_MODEL: "cerebras/truly-absent",
      ELIZAOS_CLOUD_LARGE_MODEL: "cerebras/truly-absent",
    });
    expect(registry.getTextModelReadiness().status).toBe("model_not_available");
  });
  it("never treats a display name as provider/model identity evidence", () => {
    expect(
      evaluateCloudTextModelReadiness({
        catalogLoaded: true,
        checkedAt: 1,
        catalogFailedAt: 0,
        models: [{ id: "openai/real-model", name: pinned, provider: "openai" }],
        readSetting: (key) => selected[key as keyof typeof selected],
      }).status
    ).toBe("model_not_available");
  });
  it("does not admit an explicitly unknown owner merely because the bare id is literal", async () => {
    catalog.entries = [{ id: "unbound-model", owned_by: "unknown" }];
    const registry = await startRegistry({
      ELIZAOS_CLOUD_SMALL_MODEL: "unbound-model",
      ELIZAOS_CLOUD_LARGE_MODEL: "unbound-model",
    });
    expect(registry.getTextModelReadiness().status).toBe("model_not_available");
  });
});
