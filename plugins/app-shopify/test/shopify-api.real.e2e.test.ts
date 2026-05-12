import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { req } from "../../../packages/app-core/test/helpers/http.ts";
import { startLiveRuntimeServer } from "../../../packages/app-core/test/helpers/live-runtime-server.ts";
import type { RuntimeHarness } from "../../../packages/app-core/test/live-agent/helpers/runtime-harness.ts";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";

const LIVE = process.env.ELIZA_LIVE_TEST === "1";

async function waitForShopifyRoute(runtime: RuntimeHarness): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastStatus = 0;

  while (Date.now() < deadline) {
    const response = await req(runtime.port, "GET", "/api/shopify/status");
    lastStatus = response.status;
    if (response.status !== 404) {
      return;
    }
    await sleep(500);
  }

  throw new Error(
    `Shopify route never registered (last status ${lastStatus}). Logs:\n${runtime.logs()}`,
  );
}

describeIf(LIVE)("Shopify API live route coverage", () => {
  let runtime: RuntimeHarness;

  beforeAll(async () => {
    runtime = await startLiveRuntimeServer({
      tempPrefix: "eliza-shopify-api-",
      loggingLevel: "warn",
      pluginsAllow: ["@elizaos/app-shopify"],
      env: {
        SHOPIFY_STORE_DOMAIN: undefined,
        SHOPIFY_ACCESS_TOKEN: undefined,
      },
    });
    await waitForShopifyRoute(runtime);
  }, 180_000);

  afterAll(async () => {
    await runtime?.close();
  });

  it("serves /api/shopify/status through the real API server", async () => {
    const response = await req(runtime.port, "GET", "/api/shopify/status");
    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      connected: false,
      shop: null,
    });
  });

  it("returns the real unconfigured error for /api/shopify/products", async () => {
    const response = await req(runtime.port, "GET", "/api/shopify/products");
    expect(response.status).toBe(404);
    expect(response.data).toMatchObject({
      error: expect.stringContaining("Shopify not configured"),
    });
  });
});
