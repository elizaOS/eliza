import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { req } from "../../../packages/app-core/test/helpers/http.ts";
import { startLiveRuntimeServer } from "../../../packages/app-core/test/helpers/live-runtime-server.ts";
import type { RuntimeHarness } from "../../../packages/app-core/test/live-agent/helpers/runtime-harness.ts";

const LIVE = process.env.ELIZA_LIVE_TEST === "1";

async function waitForVincentRoute(runtime: RuntimeHarness): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastStatus = 0;

  while (Date.now() < deadline) {
    const response = await req(runtime.port, "GET", "/api/vincent/status");
    lastStatus = response.status;
    if (response.status !== 404) {
      return;
    }
    await sleep(500);
  }

  throw new Error(
    `Vincent route never registered (last status ${lastStatus}). Logs:\n${runtime.logs()}`,
  );
}

describeIf(LIVE)("Vincent API live route coverage", () => {
  let runtime: RuntimeHarness;

  beforeAll(async () => {
    runtime = await startLiveRuntimeServer({
      tempPrefix: "eliza-vincent-api-",
      loggingLevel: "warn",
      pluginsAllow: ["@elizaos/app-vincent"],
    });
    await waitForVincentRoute(runtime);
  }, 180_000);

  afterAll(async () => {
    await runtime?.close();
  });

  it("serves /api/vincent/status through the real API server", async () => {
    const response = await req(runtime.port, "GET", "/api/vincent/status");
    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      connected: false,
      connectedAt: null,
      tradingVenues: ["hyperliquid", "polymarket"],
    });
  });

  it("serves /api/vincent/disconnect through the real API server", async () => {
    const response = await req(runtime.port, "POST", "/api/vincent/disconnect");
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
  });
});
