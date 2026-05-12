/**
 * App-Training live e2e tests.
 *
 * Boots a real runtime and tests the training API endpoints.
 * Training routes return 503 when the training service backend
 * is unavailable (no MLX/CUDA), which is the expected behavior
 * in most test environments. This test validates that the routes
 * are registered, respond correctly, and degrade gracefully.
 *
 * Gated on ELIZA_LIVE_TEST=1.
 */
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests";
import { req } from "../../../test/helpers/http";

const LIVE = process.env.ELIZA_LIVE_TEST === "1";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  /* dotenv optional */
}

// ``live-runtime-server`` and ``@elizaos/app-training`` are imported lazily
// because ``startApiServer`` transitively imports ``@elizaos/plugin-imessage``,
// which isn't symlinked into every workspace and would otherwise break
// collection of this file even when the LIVE gate is off.
type Runtime = Awaited<
  ReturnType<
    typeof import("../../../packages/app-core/test/helpers/live-runtime-server").startLiveRuntimeServer
  >
>;

describeIf(LIVE)("App-Training: API e2e", () => {
  let runtime: Runtime;

  beforeAll(async () => {
    const { startLiveRuntimeServer } = await import(
      "../../../packages/app-core/test/helpers/live-runtime-server"
    );
    const { trainingPlugin } = await import("@elizaos/app-training");
    runtime = await startLiveRuntimeServer({
      plugins: [trainingPlugin],
      tempPrefix: "eliza-training-e2e-",
    });
  }, 180_000);

  afterAll(async () => {
    await runtime?.close();
  }, 30_000);

  it("training routes are registered and respond", async () => {
    // Training routes return 200 when service is available, 503 when backend
    // (MLX/CUDA) is unavailable. Both are valid — the route is registered.
    const endpoints = [
      "/api/training/status",
      "/api/training/context-catalog",
      "/api/training/trajectories",
      "/api/training/blueprints",
      "/api/training/datasets",
      "/api/training/jobs",
      "/api/training/models",
    ];

    for (const endpoint of endpoints) {
      const res = await req(runtime.port, "GET", endpoint);
      // Routes should respond with 200 or 503 (service unavailable) — never 404
      expect(
        [200, 503].includes(res.status),
        `${endpoint} returned unexpected status ${res.status}`,
      ).toBe(true);
      expect(res.data).toBeTruthy();
    }
  }, 60_000);

  it("context-audit endpoint responds", async () => {
    const res = await req(runtime.port, "GET", "/api/training/context-audit");
    // May return 200, 503, or 404 depending on service availability
    expect([200, 503]).toContain(res.status);
  }, 30_000);

  it("trajectory route handles POST export", async () => {
    const res = await req(
      runtime.port,
      "POST",
      "/api/training/trajectories/export",
      {
        format: "jsonl",
      },
    );
    // Export may create an artifact (201), return one immediately (200),
    // degrade when the service is unavailable (503), or reject bad input (400).
    expect([200, 201, 400, 503]).toContain(res.status);
  }, 30_000);
});
