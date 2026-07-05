/**
 * Error-policy pin for the vertex model registry (#13415): a FAILED internal
 * call must surface, and must stay distinguishable from a legitimately-empty
 * result. `syncJobStatus` resolves a job, then re-syncs it against the remote
 * Vertex tuning API. Two outcomes that must never collapse into each other:
 *   - job not visible/found  -> null  (designed-empty; no remote call, no write)
 *   - remote status call fails -> throws (never swallowed to null, never a write)
 *
 * Drives the real exported service; db client + object store are module-mocked
 * and the remote layer is exercised through the real `getTuningJobStatus` with a
 * mocked global fetch (restored in afterEach).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.GOOGLE_ACCESS_TOKEN = "test-access-token";

const findFirst = mock(async (): Promise<unknown> => undefined);
const updateReturning = mock(async (): Promise<unknown[]> => []);
const update = mock(() => ({
  set: () => ({ where: () => ({ returning: updateReturning }) }),
}));

mock.module("../../db/client", () => ({
  dbRead: { query: { vertexTuningJobs: { findFirst } } },
  dbWrite: { update },
}));

mock.module("../storage/object-store", () => ({
  hydrateJsonField: mock(async () => ({})),
  offloadJsonField: mock(async () => ({ value: {}, storage: null, key: null })),
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  findFirst.mockReset();
  update.mockClear();
  updateReturning.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("vertex-model-registry syncJobStatus — fail-closed error policy", () => {
  test("not-found job returns null WITHOUT a remote call or write (designed-empty)", async () => {
    findFirst.mockResolvedValueOnce(undefined);
    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { vertexModelRegistryService } = await import("./vertex-model-registry");
    const result = await vertexModelRegistryService.syncJobStatus({
      jobId: "missing-job",
      viewer: { organizationId: "11111111-1111-1111-1111-111111111111" },
    });

    expect(result).toBeNull();
    // A designed-empty result never touches the remote API or the DB write.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test("remote status failure PROPAGATES — never swallowed to null, never a write", async () => {
    findFirst.mockResolvedValueOnce({
      id: "job-1",
      vertex_job_name: "projects/p/locations/us-central1/tuningJobs/1",
      display_name: "Job 1",
      organization_id: null,
      scope: "global",
    });
    const fetchSpy = mock(async () => new Response("upstream unavailable", { status: 503 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { vertexModelRegistryService } = await import("./vertex-model-registry");

    await expect(
      vertexModelRegistryService.syncJobStatus({ jobId: "job-1", viewer: {} }),
    ).rejects.toThrow(/Failed to get tuning job status/);

    // The failure was observed BEFORE any write — no fabricated success row.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
