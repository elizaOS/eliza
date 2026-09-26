/**
 * Deployment-polling resilience for CloudContainerService. A retryable cloud
 * API failure inside one poll must count as an attempt and re-arm the chain on
 * the normal backoff; a permanent authorization/not-found failure must end it;
 * a poll that settles after stop()/deleteContainer() must not reschedule; and
 * every failure must reach the runtime error boundary. Deterministic harness —
 * the real service, a real AgentRuntime, and the real Cloud SDK client over a
 * scripted fetch transport, driven by fake timers.
 */
import { AgentRuntime, type Character, type ReportedError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiClient } from "../utils/cloud-api";
import { CloudContainerService } from "./cloud-container";

const ID = "container-1";
const BASE_INTERVAL_MS = 5_000;
const POLL_SCOPE = "CloudContainerService.deploymentPolling";

/** One scripted reply to `GET /containers/:id`. */
type PollReply =
  | { status: string }
  | { httpError: number }
  | { networkError: true }
  | { pending: Promise<Response> };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let active: CloudContainerService | null = null;

/** Deploys container `ID` through the public API; the last reply repeats. */
async function deploy(replies: PollReply[]) {
  const polls: number[] = [];
  const healthChecks: number[] = [];
  const fetchImpl = (async (input, init) => {
    const method = init?.method ?? "GET";
    const { pathname } = new URL(String(input));
    if (method === "POST" && pathname.endsWith("/containers")) {
      return json(200, {
        success: true,
        data: { id: ID, status: "deploying" },
        stackName: "stack-1",
      });
    }
    if (method === "DELETE" && pathname.endsWith(`/containers/${ID}`)) {
      return json(200, { success: true, message: "deleted" });
    }
    if (method === "GET" && pathname.endsWith(`/containers/${ID}/health`)) {
      healthChecks.push(Date.now());
      return json(200, { success: true, data: { healthy: true, status: "ok" } });
    }
    if (method === "GET" && pathname.endsWith(`/containers/${ID}`)) {
      const reply = replies[Math.min(polls.length, replies.length - 1)];
      polls.push(Date.now());
      if ("status" in reply) {
        return json(200, { success: true, data: { id: ID, status: reply.status } });
      }
      if ("httpError" in reply) {
        return json(reply.httpError, {
          success: false,
          error: `HTTP ${reply.httpError} from cloud API`,
        });
      }
      if ("networkError" in reply) throw new TypeError("fetch failed");
      return reply.pending;
    }
    throw new Error(`unexpected ${method} ${pathname}`);
  }) as typeof fetch;

  const runtime = new AgentRuntime({
    character: { name: "cloud-container-poll" } as Character,
  });
  const client = new CloudApiClient("https://cloud.test/api/v1", undefined, {
    fetchImpl,
  });
  const service = new CloudContainerService(runtime);
  (service as unknown as { authService: unknown }).authService = {
    isAuthenticated: () => true,
    getClient: () => client,
  };
  active = service;

  const started = Date.now();
  await service.createContainer({
    name: "app",
    project_name: "proj",
    ecr_image_uri: "registry.test/app:1",
  });
  const pollOffsets = () => polls.map((at) => at - started);
  const reported = (): ReportedError[] =>
    runtime.getRecentReportedErrors().filter((entry) => entry.scope === POLL_SCOPE);
  return { service, polls, healthChecks, pollOffsets, reported };
}

describe("CloudContainerService deployment polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await active?.stop();
    active = null;
    vi.useRealTimers();
  });

  it("keeps polling on the backoff schedule while the container is deploying (harness control)", async () => {
    const { pollOffsets, reported } = await deploy([{ status: "deploying" }]);

    await vi.advanceTimersByTimeAsync(100_000);

    expect(pollOffsets()).toEqual([5_000, 10_000, 20_000, 40_000, 70_000, 100_000]);
    expect(reported()).toEqual([]);
  });

  it("re-arms the chain after a transient failure and still reaches running", async () => {
    const { service, polls, healthChecks, reported } = await deploy([
      { httpError: 503 },
      { status: "running" },
    ]);

    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS); // poll #1 gets a 503
    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS); // poll #2 must still happen

    expect(polls).toHaveLength(2);
    expect(service.getTrackedContainer(ID)?.status).toBe("running");
    expect(reported()).toMatchObject([
      {
        code: "CLOUD_CONTAINER_POLL_RETRYABLE",
        context: { containerId: ID, attempt: 1, statusCode: 503, nextPollInMs: 5_000 },
      },
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(healthChecks).toHaveLength(1);
  });

  it("retries transport failures on the same backoff a successful poll uses", async () => {
    const { pollOffsets, reported } = await deploy([{ networkError: true }]);

    await vi.advanceTimersByTimeAsync(100_000);

    expect(pollOffsets()).toEqual([5_000, 10_000, 20_000, 40_000, 70_000, 100_000]);
    expect(reported().map((entry) => entry.code)).toEqual(
      Array(6).fill("CLOUD_CONTAINER_POLL_RETRYABLE")
    );
    expect(reported()[5]?.context).toMatchObject({ statusCode: null, nextPollInMs: 30_000 });
  });

  it("counts failed polls against the attempt budget and stops at the limit", async () => {
    const { polls, reported } = await deploy([{ httpError: 502 }]);

    // 120 attempts at ≤30s each is well under two fake hours.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    expect(polls).toHaveLength(120);
    expect(vi.getTimerCount()).toBe(0);
    expect(reported().at(-1)).toMatchObject({
      code: "CLOUD_CONTAINER_POLL_TIMEOUT",
      context: { containerId: ID, attempts: 120, lastObservedStatus: "deploying" },
    });
  });

  it.each([401, 403, 404])(
    "stops on a permanent HTTP %i instead of retrying it",
    async (httpError) => {
      const { service, polls, reported } = await deploy([{ httpError }, { status: "running" }]);

      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

      expect(polls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(service.getTrackedContainer(ID)?.status).toBe("deploying");
      expect(reported()).toMatchObject([
        {
          code: "CLOUD_CONTAINER_POLL_REJECTED",
          context: { containerId: ID, attempt: 1, statusCode: httpError, nextPollInMs: null },
        },
      ]);
    }
  );

  it.each([
    [
      "resolves as still deploying",
      (): Response => json(200, { success: true, data: { id: ID, status: "deploying" } }),
    ],
    [
      "rejects with a 503",
      (): Response => json(503, { success: false, error: "HTTP 503 from cloud API" }),
    ],
    [
      "resolves as running",
      (): Response => json(200, { success: true, data: { id: ID, status: "running" } }),
    ],
  ])(
    "does not reschedule when stop() lands while the poll request is in flight and it %s",
    async (_label, reply) => {
      const inFlight = deferred<Response>();
      const { service, polls, healthChecks, reported } = await deploy([
        { pending: inFlight.promise },
        { status: "deploying" },
      ]);

      await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS); // poll #1 is now awaiting the API
      expect(polls).toHaveLength(1);
      await service.stop();
      inFlight.resolve(reply());
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

      expect(polls).toHaveLength(1);
      expect(healthChecks).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(reported()).toEqual([]);
    }
  );

  it("does not reschedule when deleteContainer() lands while a failing poll is in flight", async () => {
    const inFlight = deferred<Response>();
    const { service, polls, reported } = await deploy([
      { pending: inFlight.promise },
      { status: "deploying" },
    ]);

    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS);
    await service.deleteContainer(ID);
    inFlight.reject(new TypeError("fetch failed"));
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    expect(polls).toHaveLength(1);
    expect(service.getTrackedContainer(ID)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(reported()).toEqual([]);
  });
});
