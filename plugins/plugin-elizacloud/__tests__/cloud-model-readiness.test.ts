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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloudAuthService } from "../src/services/cloud-auth";
import { CloudModelRegistryService } from "../src/services/cloud-model-registry";

let server: http.Server;
let baseUrl: string;
let catalog: { status: number; ids: string[] };
let modelRequests = 0;

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
    if (req.url?.endsWith("/models")) modelRequests += 1;
    res.writeHead(catalog.status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        catalog.status === 200
          ? {
              object: "list",
              data: catalog.ids.map((id) => ({ id, object: "model", created: 1, owned_by: "x" })),
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

beforeEach(() => {
  modelRequests = 0;
  catalog = {
    status: 200,
    ids: [
      DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
      DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
      "vendor/listed-large",
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
