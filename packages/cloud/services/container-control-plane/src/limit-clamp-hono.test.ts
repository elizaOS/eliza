/**
 * Exercises the authenticated provisioning-job limit contract through the Hono app.
 * A deterministic service replacement captures the exact batch size sent downstream.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { provisioningJobService } from "@elizaos/cloud-shared/lib/services/provisioning-jobs";
import { app } from "./index";

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
  const body = (await res.json()) as {
    success: boolean;
    data: { batchSize: number };
  };
  expect(body.success).toBe(true);
  expect(typeof body.data.batchSize).toBe("number");
  // The response and delegated service input must describe the same batch.
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

  test("scientific notation falls back to 5", async () => {
    expect(await getBatchSize("?limit=1e4")).toBe(5);
  });

  test("decimal input falls back to 5", async () => {
    expect(await getBatchSize("?limit=5.5")).toBe(5);
  });

  test("zero falls back to 5", async () => {
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
