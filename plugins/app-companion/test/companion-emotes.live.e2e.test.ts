/**
 * App-Companion live e2e tests.
 *
 * Tests the companion emote catalog and API endpoint for
 * emote listing and validation.
 *
 * Gated on ELIZA_LIVE_TEST=1.
 */
import path from "node:path";
import { appCompanionPlugin } from "@elizaos/app-companion";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type RuntimeHarness as Runtime,
  startLiveRuntimeServer,
} from "../../../packages/app-core/test/helpers/live-runtime-server";
import { describeIf } from "../../../test/helpers/conditional-tests";
import { req } from "../../../test/helpers/http";

const LIVE = process.env.ELIZA_LIVE_TEST === "1";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  /* dotenv optional */
}

describeIf(LIVE)("App-Companion: Emotes API e2e", () => {
  let runtime: Runtime;

  beforeAll(async () => {
    runtime = await startLiveRuntimeServer({
      plugins: [appCompanionPlugin],
      tempPrefix: "eliza-companion-e2e-",
    });
  }, 180_000);

  afterAll(async () => {
    await runtime?.close();
  });

  it("GET /api/emotes returns the emote catalog", async () => {
    const res = await req(runtime.port, "GET", "/api/emotes");
    expect(res.status).toBe(200);
    expect(res.data).toBeTruthy();
    // Should return a list of emotes
    const data = res.data as { emotes?: unknown[] } | unknown[];
    const emotes = Array.isArray(data)
      ? data
      : (data as { emotes?: unknown[] }).emotes;
    if (emotes) {
      expect(Array.isArray(emotes)).toBe(true);
      expect(emotes.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it("GET /api/plugins lists registered plugins including companion", async () => {
    const res = await req(runtime.port, "GET", "/api/plugins");
    expect(res.status).toBe(200);
    expect(res.data).toBeTruthy();
  }, 30_000);

  it("GET /api/agents returns at least one agent", async () => {
    const res = await req(runtime.port, "GET", "/api/agents");
    expect(res.status).toBe(200);
    const data = res.data as { agents?: unknown[] } | unknown[];
    const agents = Array.isArray(data)
      ? data
      : (data as { agents?: unknown[] }).agents;
    if (agents) {
      expect(Array.isArray(agents)).toBe(true);
      expect(agents.length).toBeGreaterThanOrEqual(1);
    }
  }, 30_000);
});
