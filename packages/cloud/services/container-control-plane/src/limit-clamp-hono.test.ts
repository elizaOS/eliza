/**
 * Hono `app.request` coverage for strict limit clamp on
 * `GET|POST /api/v1/cron/process-provisioning-jobs?limit=` — container-control-plane.
 *
 * Proves the handler uses `parseClampedLimit(..., 5, 25)` (strict `/^\d+$/` + isSafeInteger)
 * instead of the weak `Number(query ?? "5")` + Math clamp that accepted `1e4 → 10000 → 25`,
 * `5.5 → 5.5`, `0 → 1`, etc.
 *
 * Mutation-proof: if the file is reverted to `Number(c.req.query("limit") ?? "5")`
 * or an override `if (raw==="1e4") batchSize=25` is inserted after parseClampedLimit,
 * these `batchSize` assertions fail (expected fallback 5, got 25 / 5.5).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { app } from "./index";
import { provisioningJobService } from "@elizaos/cloud-shared/lib/services/provisioning-jobs";

const TOKEN = "limit-clamp-hono-token";
const HEADER = "x-container-control-plane-token";
const ROUTE = "/api/v1/cron/process-provisioning-jobs";

let origProcessPendingJobs: typeof provisioningJobService.processPendingJobs;
let capturedBatchSize: number | null;

beforeEach(() => {
  process.env.CONTAINER_CONTROL_PLANE_TOKEN = TOKEN;
  capturedBatchSize = null;
  origProcessPendingJobs = provisioningJobService.processPendingJobs;
  provisioningJobService.processPendingJobs = (async (batchSize: number) => {
    capturedBatchSize = batchSize;
    return {
      claimed: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      errors: [],
    };
  }) as typeof provisioningJobService.processPendingJobs;
});

afterEach(() => {
  provisioningJobService.processPendingJobs = origProcessPendingJobs;
  delete process.env.CONTAINER_CONTROL_PLANE_TOKEN;
});

async function getBatchSize(query: string): Promise<number> {
  const res = await app.request(`${ROUTE}${query}`, {
    headers: { [HEADER]: TOKEN },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: { batchSize: number } };
  expect(body.success).toBe(true);
  expect(typeof body.data.batchSize).toBe("number");
  // also verify the service was called with the same batchSize the handler echoed
  expect(capturedBatchSize).toBe(body.data.batchSize);
  return body.data.batchSize;
}

describe("container-control-plane limit clamp via app.request", () => {
  test("valid within range → pass-through", async () => {
    expect(await getBatchSize("?limit=10")).toBe(10);
    expect(await getBatchSize("?limit=5")).toBe(5);
    expect(await getBatchSize("?limit=1")).toBe(1);
  });

  test("above max → clamped to 25", async () => {
    expect(await getBatchSize("?limit=100")).toBe(25);
    expect(await getBatchSize("?limit=26")).toBe(25);
    expect(await getBatchSize("?limit=25")).toBe(25);
  });

  test("scientific notation 1e4 → rejected to fallback 5 (old Number → 10000 → 25)", async () => {
    expect(await getBatchSize("?limit=1e4")).toBe(5);
  });

  test("decimal 5.5 → rejected to fallback 5 (old Number → 5.5)", async () => {
    expect(await getBatchSize("?limit=5.5")).toBe(5);
  });

  test("zero → rejected to fallback 5 (old Math.max(1,0) → 1)", async () => {
    expect(await getBatchSize("?limit=0")).toBe(5);
  });

  test("negative → rejected to fallback 5", async () => {
    expect(await getBatchSize("?limit=-5")).toBe(5);
  });

  test("trailing junk 5junk → rejected to fallback 5", async () => {
    expect(await getBatchSize("?limit=5junk")).toBe(5);
  });

  test("empty / missing → fallback 5", async () => {
    expect(await getBatchSize("")).toBe(5);
    expect(await getBatchSize("?limit=")).toBe(5);
  });

  test("non-numeric abc → fallback 5", async () => {
    expect(await getBatchSize("?limit=abc")).toBe(5);
  });

  test("unsafe integer beyond MAX_SAFE_INTEGER → fallback 5", async () => {
    expect(await getBatchSize("?limit=9007199254740993")).toBe(5);
  });
});
