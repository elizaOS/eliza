// Verifies the pii_scrub drain honors inspection scope when consulting and writing done-markers.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { hashScrubContent, scrubMarkerKey } from "@elizaos/core";

type Marker = { organization_id: string; marker_key: string; inspection_scope: string };
const markers: Marker[] = [];
const jobUpdates: Array<{ id: string; status: string }> = [];
let claimable: unknown[] = [];

mock.module("@/lib/utils/logger", () => ({
  logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
}));
mock.module("../../db/repositories/jobs", () => ({
  jobsRepository: {
    claimPendingJobs: async () => claimable.splice(0),
    update: async (id: string) => ({ id }),
    updateStatus: async (id: string, status: string) => {
      jobUpdates.push({ id, status });
    },
    incrementAttempt: async (id: string) => {
      jobUpdates.push({ id, status: "attempt_failed" });
      return { attempts: 1, status: "pending" };
    },
    recoverStaleJobs: async () => ({
      scanned: 0,
      retried: 0,
      permanentlyFailed: 0,
      failures: [],
    }),
  },
}));
const { satisfyingInspectionScopes } = await import("../../db/repositories/pii-scrub-markers");
mock.module("../../db/repositories/pii-scrub-markers", () => ({
  satisfyingInspectionScopes,
  piiScrubMarkersRepository: {
    isDone: async (orgId: string, key: string, scope: "declared_candidates" | "server_discovery") =>
      markers.some(
        (m) =>
          m.organization_id === orgId &&
          m.marker_key === key &&
          satisfyingInspectionScopes(scope).includes(
            m.inspection_scope as "declared_candidates" | "server_discovery",
          ),
      ),
    tryCreate: async (row: Marker) => {
      markers.push(row);
      return { created: true, marker: row };
    },
  },
}));

const { processPendingPiiScrubJobs, readPiiScrubJobData } = await import("./pii-scrub-jobs");
const { createPiiScrubItemExecutor } = await import("./pii-scrub-executor");

const ORG = "00000000-0000-4000-8000-000000000001";
const CONTENT = "Call Alice about the lab results.";

function job(id: string, inspectionScope?: "declared_candidates" | "server_discovery") {
  return {
    id,
    type: "pii_scrub",
    organization_id: ORG,
    max_attempts: 3,
    data: {
      organizationId: ORG,
      userId: "00000000-0000-4000-8000-000000000009",
      rulesetVersion: "r1",
      ...(inspectionScope ? { inspectionScope } : {}),
      items: [{ itemRef: "row-1", content: CONTENT }],
    },
  };
}

beforeEach(() => {
  markers.length = 0;
  jobUpdates.length = 0;
});

describe("pii_scrub drain inspection scope", () => {
  test("empty candidates under declared scope write a declared-candidates marker", async () => {
    claimable = [job("j1")];
    const result = await processPendingPiiScrubJobs({ executor: createPiiScrubItemExecutor() });
    expect(result.succeeded).toBe(1);
    expect(markers).toEqual([
      expect.objectContaining({
        marker_key: `${scrubMarkerKey(hashScrubContent(CONTENT), "r1")}:declared:${hashScrubContent(JSON.stringify([[], null]))}`,
        inspection_scope: "declared_candidates",
        candidate_count: 0,
      }),
    ]);
  });

  test("a weaker marker does not skip a server-discovery job, which fails closed", async () => {
    claimable = [job("j1")];
    await processPendingPiiScrubJobs({ executor: createPiiScrubItemExecutor() });
    claimable = [job("j2", "server_discovery")];
    const result = await processPendingPiiScrubJobs({ executor: createPiiScrubItemExecutor() });
    expect(result.failed).toBe(1);
    expect(markers.map((m) => m.inspection_scope)).toEqual(["declared_candidates"]);
    expect(jobUpdates).toContainEqual({ id: "j2", status: "attempt_failed" });
  });

  test("an empty-candidate marker cannot skip newly declared candidates", async () => {
    claimable = [job("empty")];
    await processPendingPiiScrubJobs({ executor: createPiiScrubItemExecutor() });
    const next = job("new-candidates");
    Object.assign(next.data.items[0], { candidateSpans: ["Alice"] });
    claimable = [next];
    const result = await processPendingPiiScrubJobs({ executor: createPiiScrubItemExecutor() });
    expect(result.failed).toBe(1);
    expect(jobUpdates).toContainEqual({ id: "new-candidates", status: "attempt_failed" });
    expect(markers).toHaveLength(1);
  });

  test("the same declaration resumes without executing again", async () => {
    claimable = [job("first")];
    await processPendingPiiScrubJobs({ executor: createPiiScrubItemExecutor() });
    claimable = [job("again")];
    const scrubItem = mock(async () => {
      throw new Error("must not execute");
    });
    const result = await processPendingPiiScrubJobs({ executor: { scrubItem } });
    expect(result.succeeded).toBe(1);
    expect(scrubItem).not.toHaveBeenCalled();
    expect(markers).toHaveLength(1);
  });

  test("a full-content marker still satisfies a declared-candidate job", async () => {
    markers.push({
      organization_id: ORG,
      marker_key: scrubMarkerKey(hashScrubContent(CONTENT), "r1"),
      inspection_scope: "server_discovery",
    });
    const next = job("strong-marker");
    Object.assign(next.data.items[0], { candidateSpans: ["Alice"] });
    claimable = [next];
    const scrubItem = mock(async () => {
      throw new Error("must not execute");
    });
    const result = await processPendingPiiScrubJobs({ executor: { scrubItem } });
    expect(result.succeeded).toBe(1);
    expect(scrubItem).not.toHaveBeenCalled();
    expect(markers).toHaveLength(1);
  });

  test("changed context and legacy partial markers cannot skip inspection", async () => {
    claimable = [job("first")];
    await processPendingPiiScrubJobs({ executor: createPiiScrubItemExecutor() });
    markers.push({
      organization_id: ORG,
      marker_key: scrubMarkerKey(hashScrubContent(CONTENT), "r1"),
      inspection_scope: "declared_candidates",
    });
    const next = job("changed-context");
    Object.assign(next.data.items[0], { contextPack: "new context" });
    claimable = [next];
    const scrubItem = mock(async () => {
      throw new Error("requires inspection");
    });
    const result = await processPendingPiiScrubJobs({ executor: { scrubItem } });
    expect(result.failed).toBe(1);
    expect(scrubItem).toHaveBeenCalledTimes(1);
    expect(markers).toHaveLength(2);
  });

  test("rejects an unknown inspection scope as permanently invalid job data", () => {
    const bad = job("j3");
    (bad.data as Record<string, unknown>).inspectionScope = "none";
    expect(() => readPiiScrubJobData(bad as never)).toThrow("Invalid pii_scrub job data");
  });
});
