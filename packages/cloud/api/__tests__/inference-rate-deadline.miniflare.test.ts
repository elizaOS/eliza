/** Tests the production rate caller against the real SQLite actor and input gate. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import type { InferenceRateLimitDecision } from "../../shared/src/lib/services/inference-admission-gate";

interface RateInspection {
  requests: Record<string, unknown>[];
  counters: Record<string, { count: number }> | null;
}

const apiRoot = fileURLToPath(new URL("../", import.meta.url));
let worker: Promise<{ script: string; scriptPath: string }> | undefined;
let buildDirectory: string | undefined;
async function workerSource(): Promise<{ script: string; scriptPath: string }> {
  worker ??= (async () => {
    buildDirectory = await mkdtemp(resolve(tmpdir(), "cloud-rate-deadline-"));
    // The normal Worker build owns aliases and Node compatibility. Import the
    // full production caller; do not substitute its financial dependencies.
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(apiRoot, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        resolve(apiRoot, "test/fixtures/inference-rate-deadline-worker.ts"),
        "--config",
        resolve(apiRoot, "wrangler.toml"),
        "--env",
        "staging",
        "--dry-run",
        "--outdir",
        buildDirectory,
      ],
      {
        cwd: apiRoot,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (status !== 0)
      throw new Error(`Normal rate fixture build failed: ${stdout}\n${stderr}`);
    const scriptPath = resolve(
      buildDirectory,
      "inference-rate-deadline-worker.js",
    );
    return { scriptPath, script: await readFile(scriptPath, "utf8") };
  })();
  return await worker;
}

afterAll(async () => {
  if (buildDirectory)
    await rm(buildDirectory, { recursive: true, force: true });
});

async function withWorker(
  delayMs: number,
  operation: (
    post: (path: string, body?: unknown) => Promise<Response>,
  ) => Promise<void>,
): Promise<void> {
  const built = await workerSource();
  const runtime = new Miniflare({
    modules: [
      { type: "ESModule", path: "rate-worker.js", contents: built.script },
    ],
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    bindings: { TEST_INPUT_DELAY_MS: String(delayMs) },
    durableObjects: {
      INFERENCE_ADMISSION_GATES: {
        className: "DelayedInferenceAdmissionGate",
        useSQLite: true,
      },
    },
  });
  try {
    await runtime.ready;
    await operation(
      async (path, body) =>
        (await runtime.dispatchFetch(`https://gate.test${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-organization-id": "deadline-org",
          },
          body: JSON.stringify(body ?? {}),
        })) as unknown as Response,
    );
  } finally {
    await runtime.dispose();
  }
}

describe("rate admission dispatch deadline", () => {
  test("admits once after a three-second input delay and retains caps and receipts", async () => {
    await withWorker(3_164, async (post) => {
      const allowed = await post("/consume");
      expect(allowed.status).toBe(200);
      const first = (await allowed.json()) as InferenceRateLimitDecision;
      expect(first.allowed).toBe(true);
      const initial = (await (
        await post("/test-inspect")
      ).json()) as RateInspection;
      expect(initial.requests).toHaveLength(1);
      expect(initial.counters?.completions?.count).toBe(1);
      const original = initial.requests[0];
      const replay = await post("/rate-limit", original);
      expect(replay.status).toBe(200);
      const replayDecision =
        (await replay.json()) as InferenceRateLimitDecision;
      expect(replayDecision).toEqual(first);
      expect(
        (await post("/rate-limit", { ...original, maxRequests: 3 })).status,
      ).toBe(409);
      expect(
        (
          await post("/rate-limit", {
            ...original,
            operationId: "second",
            maxRequests: 3,
          })
        ).status,
      ).toBe(200);
      // The key cap denies while the organization still has one request left.
      expect(
        (
          await post("/rate-limit", {
            ...original,
            operationId: "over-key-cap",
            maxRequests: 3,
          })
        ).status,
      ).toBe(429);
      // A fresh key cannot bypass the organization's exhausted window.
      expect(
        (
          await post("/rate-limit", {
            ...original,
            operationId: "over-org-cap",
            maxRequests: 3,
            apiKey: { id: "other-key", maxRequests: 10 },
          })
        ).status,
      ).toBe(429);
      const final = (await (
        await post("/test-inspect")
      ).json()) as RateInspection;
      expect(final.counters?.completions?.count).toBe(4);
      expect(final.counters?.["api-key:test-key"]?.count).toBe(3);
    });
  }, 60_000);

  test("accepts a five-second validity envelope and rejects expired operations without consumption", async () => {
    await withWorker(0, async (post) => {
      const request = {
        endpointType: "completions",
        windowMs: 60_000,
        maxRequests: 2,
        operationId: "valid-envelope",
        operationDeadlineAt: Date.now() + 4_500,
      };
      expect((await post("/rate-limit", request)).status).toBe(200);
      const before = (await (
        await post("/test-inspect")
      ).json()) as RateInspection;
      expect(
        (
          await post("/rate-limit", {
            ...request,
            operationId: "expired",
            operationDeadlineAt: Date.now() - 1,
          })
        ).status,
      ).toBe(409);
      const after = (await (
        await post("/test-inspect")
      ).json()) as RateInspection;
      expect(after.counters).toEqual(before.counters);
    });
  }, 60_000);

  test("fails closed past five seconds without consuming quota", async () => {
    await withWorker(5_500, async (post) => {
      expect((await post("/consume")).status).toBe(503);
      const state = (await (
        await post("/test-inspect")
      ).json()) as RateInspection;
      expect(state.requests).toEqual([]);
      expect(state.counters).toBeNull();
    });
  }, 60_000);
});
