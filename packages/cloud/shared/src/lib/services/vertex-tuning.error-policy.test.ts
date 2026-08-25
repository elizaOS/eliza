/**
 * Pins the Vertex tuning transport layer: an internal API failure PROPAGATES as
 * a thrown error, while a legitimately-empty job list stays a distinct empty
 * result — neither is masked into a fabricated success. Deterministic harness:
 * global fetch is mocked and restored per test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getTuningJobStatus, listTuningJobs, vertexTuningFetch } from "./vertex-tuning";

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

describe("vertexTuningFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung Vertex AI API hop at the timeout", async () => {
    // An API that never settles on its own: the only way out is the caller's
    // AbortSignal firing (the 30s default bounds every tuning hop).
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;

    const start = Date.now();
    await expect(
      vertexTuningFetch("https://aiplatform.googleapis.com/v1/jobs/x", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("composes a caller-provided abort signal with the deadline", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response(JSON.stringify({ tuningJobs: [] }), { status: 200 });
    }) as typeof fetch;

    const controller = new AbortController();
    await vertexTuningFetch("https://aiplatform.googleapis.com/v1/jobs/x", {
      signal: controller.signal,
    });
    // The wrapper owns the deadline, so the transport receives a composition of
    // the caller signal and that deadline, never the caller object itself.
    expect(seen).not.toBe(controller.signal);
    expect(seen?.aborted).toBe(false);
  });

  test("still aborts at the deadline when the caller signal never fires", async () => {
    // Regression: the wrapper used to read `init?.signal ?? AbortSignal.timeout(ms)`,
    // so any caller signal REPLACED the deadline. A request-scoped controller
    // that outlives this hop and is never aborted then left the hop unbounded —
    // it stayed hung well past 10x the declared deadline against a real
    // non-responding socket.
    // Mirrors real fetch: the only way out is the signal firing, and the
    // rejection carries the signal's own reason, so the assertion below can
    // tell the wrapper's deadline (TimeoutError) from any other abort.
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(
            init.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
          );
        });
      });
    }) as typeof fetch;

    const caller = new AbortController();
    // Raced against a watchdog rather than awaited directly: an unbounded hop
    // never settles, so a regression has to surface as a failed assertion here
    // and not as a hung test file.
    const outcome = await Promise.race([
      vertexTuningFetch(
        "https://aiplatform.googleapis.com/v1/jobs/x",
        { signal: caller.signal },
        100,
      ).then(
        () => "resolved",
        (error: Error) => `aborted:${error.name}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("STILL-HUNG"), 1_000)),
    ]);
    expect(outcome).toBe("aborted:TimeoutError");
    expect(caller.signal.aborted).toBe(false);
  });

  test("still lets the caller abort early, ahead of the deadline", async () => {
    // No over-rejection: composing must not cost the caller its own cancellation.
    // Mirrors real fetch: the only way out is the signal firing, and the
    // rejection carries the signal's own reason, so the assertion below can
    // tell the wrapper's deadline (TimeoutError) from any other abort.
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(
            init.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
          );
        });
      });
    }) as typeof fetch;

    const caller = new AbortController();
    const pending = vertexTuningFetch(
      "https://aiplatform.googleapis.com/v1/jobs/x",
      { signal: caller.signal },
      60_000,
    );
    caller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
  });
});
