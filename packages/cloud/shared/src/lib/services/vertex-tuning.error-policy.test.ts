// Pins the Vertex tuning transport layer: an internal API failure PROPAGATES as a
// thrown error, while a legitimately-empty job list stays a distinct empty result —
// neither is masked into a fabricated success. Deterministic (global fetch mocked).
import { afterEach, describe, expect, test } from "bun:test";
import {
  getTuningJobStatus,
  listTuningJobs,
} from "./vertex-tuning";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(response: Response): void {
  globalThis.fetch = (async () => response) as typeof fetch;
}

describe("listTuningJobs — empty result stays distinct from internal failure", () => {
  test("designed-empty: ok response with empty list returns [] without throwing", async () => {
    stubFetch(new Response(JSON.stringify({ tuningJobs: [] }), { status: 200 }));
    const jobs = await listTuningJobs("proj", "us-central1", "token");
    expect(jobs).toEqual([]);
  });

  test("designed-empty: ok response missing the field returns []", async () => {
    stubFetch(new Response(JSON.stringify({}), { status: 200 }));
    const jobs = await listTuningJobs("proj", "us-central1", "token");
    expect(jobs).toEqual([]);
  });

  test("internal failure: non-ok response propagates as a throw, never []", async () => {
    stubFetch(new Response("upstream unavailable", { status: 500 }));
    let empty: unknown[] | undefined;
    try {
      empty = await listTuningJobs("proj", "us-central1", "token");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("500");
      expect((err as Error).message).toContain("upstream unavailable");
    }
    // The failure must NOT have resolved to an empty array masking the outage.
    expect(empty).toBeUndefined();
  });
});

describe("getTuningJobStatus — internal failure propagates", () => {
  test("non-ok response throws with status and body, no fabricated job", async () => {
    stubFetch(new Response("not found", { status: 404 }));
    await expect(
      getTuningJobStatus("projects/p/locations/l/tuningJobs/123", "token"),
    ).rejects.toThrow(/404.*not found/s);
  });

  test("ok response returns the parsed job", async () => {
    const job = {
      name: "projects/p/locations/l/tuningJobs/123",
      state: "JOB_STATE_SUCCEEDED",
      tunedModelDisplayName: "tuned-x",
      createTime: "2026-01-01T00:00:00Z",
      updateTime: "2026-01-01T01:00:00Z",
    };
    stubFetch(new Response(JSON.stringify(job), { status: 200 }));
    const result = await getTuningJobStatus(job.name, "token");
    expect(result.state).toBe("JOB_STATE_SUCCEEDED");
    expect(result.tunedModelDisplayName).toBe("tuned-x");
  });
});
