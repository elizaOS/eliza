/**
 * Exercises the tier-upgrade orchestrator, supervisor and actual Cloud client
 * against deterministic HTTP. Cancellation must stop subsequent cutover,
 * transcript import, switch and source cleanup; it cannot undo a sent request.
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../api/client-base";
import "../../api/client-cloud";
import { runSharedToDedicatedUpgradeHandoff } from "./start-tier-upgrade";

const BASE = "https://api.eliza.app";
const PERSONAL = "personal:00000000-0000-5000-8000-000000000001";
const SHARED = "00000000-0000-4000-8000-000000000010";
const TARGET = "00000000-0000-4000-8000-000000000020";
const TARGET_BASE = `https://${TARGET}.cloud.eliza.app`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

type Request = {
  url: string;
  method: string;
  signal: AbortSignal | null | undefined;
};

function fixture(
  intercept?: (request: Request) => Promise<Response> | undefined,
) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = {
        url: String(input),
        method: init?.method ?? "GET",
        signal: init?.signal,
      };
      requests.push(request);
      const intercepted = intercept?.(request);
      if (intercepted) return intercepted;
      if (request.url.endsWith("/upgrade-tier/cutover")) {
        return Response.json({
          success: true,
          data: {
            personalElizaId: PERSONAL,
            activeAgentId: TARGET,
            runtime: "dedicated",
            apiBase: TARGET_BASE,
            importedMessages: 1,
          },
        });
      }
      if (request.url === `${BASE}/api/v1/eliza/agents/${TARGET}`) {
        return Response.json({
          success: true,
          data: {
            id: TARGET,
            name: "Eliza",
            status: "running",
            executionTier: "dedicated-always",
            webUiUrl: TARGET_BASE,
          },
        });
      }
      if (request.url === `${TARGET_BASE}/api/health`)
        return Response.json({ ready: true });
      if (request.url.endsWith("/messages"))
        return Response.json({
          messages: [{ role: "user", text: "fixture transcript" }],
        });
      if (request.url.endsWith("/import"))
        return Response.json({ inserted: 1 });
      if (
        request.url === `${BASE}/api/v1/eliza/agents/${SHARED}` &&
        request.method === "DELETE"
      )
        return Response.json({ success: true });
      throw new Error(
        `Unexpected fixture request: ${request.method} ${request.url}`,
      );
    },
  );
  return requests;
}

function start(sharedAgentId: string, signal: AbortSignal, onSwitch = vi.fn()) {
  return runSharedToDedicatedUpgradeHandoff({
    sharedAgentId,
    dedicatedAgentId: TARGET,
    cloudApiBase: BASE,
    authToken: "fixture-token",
    client: new ElizaClient(BASE, "fixture-token"),
    signal,
    onSwitch,
    intervalMs: 1,
    timeoutMs: 250,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Dedicated handoff cancellation at HTTP boundaries", () => {
  it("settles a cancelled rowless cutover without waiting for its late response", async () => {
    const pending = deferred<Response>();
    const reached = deferred<Request>();
    const requests = fixture((request) => {
      if (request.url.endsWith("/cutover")) {
        reached.resolve(request);
        return pending.promise;
      }
    });
    const controller = new AbortController();
    const onSwitch = vi.fn();
    const attempt = start(PERSONAL, controller.signal, onSwitch);
    const request = await reached.promise;
    controller.abort();
    expect((await attempt).status).toBe("failed");
    expect(request.signal?.aborted).toBe(true);
    pending.resolve(
      Response.json({
        success: true,
        data: {
          personalElizaId: PERSONAL,
          activeAgentId: TARGET,
          runtime: "dedicated",
          apiBase: TARGET_BASE,
          importedMessages: 1,
        },
      }),
    );
    await Promise.resolve();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("cancels a long cutover retry wait and never posts another attempt", async () => {
    vi.useFakeTimers();
    const requests = fixture((request) =>
      request.url.endsWith("/cutover")
        ? Promise.resolve(
            Response.json({ error: "Not ready" }, { status: 503 }),
          )
        : undefined,
    );
    const controller = new AbortController();
    const onSwitch = vi.fn();
    const attempt = runSharedToDedicatedUpgradeHandoff({
      sharedAgentId: PERSONAL,
      dedicatedAgentId: TARGET,
      cloudApiBase: BASE,
      authToken: "fixture-token",
      client: new ElizaClient(BASE, "fixture-token"),
      signal: controller.signal,
      onSwitch,
      intervalMs: 60_000,
      timeoutMs: 180_000,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect((await attempt).status).toBe("failed");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests).toHaveLength(1);
    expect(onSwitch).not.toHaveBeenCalled();
  });
  it.each([PERSONAL, SHARED])(
    "does not dispatch an already cancelled handoff for %s",
    async (source) => {
      const requests = fixture();
      const controller = new AbortController();
      controller.abort();
      const onSwitch = vi.fn();
      expect((await start(source, controller.signal, onSwitch)).status).toBe(
        "failed",
      );
      expect(requests).toEqual([]);
      expect(onSwitch).not.toHaveBeenCalled();
    },
  );

  it("does not retry a rowless cutover after cancellation even if its response is retryable", async () => {
    const controller = new AbortController();
    let calls = 0;
    const requests = fixture((request) => {
      if (request.url.endsWith("/cutover") && calls++ === 0) {
        controller.abort();
        return Promise.resolve(
          Response.json({ error: "Not ready" }, { status: 503 }),
        );
      }
    });
    const onSwitch = vi.fn();
    expect((await start(PERSONAL, controller.signal, onSwitch)).status).toBe(
      "failed",
    );
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(
      1,
    );
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it.each(["messages", "import"] as const)(
    "stops the legacy handoff after cancellation while %s is pending",
    async (step) => {
      const pending = deferred<Response>();
      const reached = deferred<Request>();
      const requests = fixture((request) => {
        if (request.url.endsWith(`/${step}`)) {
          reached.resolve(request);
          return pending.promise;
        }
      });
      const controller = new AbortController();
      const onSwitch = vi.fn();
      const attempt = start(SHARED, controller.signal, onSwitch);
      const request = await reached.promise;
      controller.abort();
      pending.resolve(
        Response.json(
          step === "messages"
            ? { messages: [{ role: "user", text: "late transcript" }] }
            : { inserted: 1 },
        ),
      );
      const outcome = await attempt;
      expect(outcome.status).toBe("failed");
      expect(request.signal?.aborted).toBe(true);
      expect(onSwitch).not.toHaveBeenCalled();
      expect(requests.filter((request) => request.method === "DELETE")).toEqual(
        [],
      );
      expect(
        requests.filter((request) => request.url.endsWith("/import")),
      ).toHaveLength(step === "import" ? 1 : 0);
    },
  );

  it("does not delete the legacy source when cancellation arrives during the switch callback", async () => {
    const requests = fixture();
    const controller = new AbortController();
    const onSwitch = vi.fn(() => controller.abort());
    expect((await start(SHARED, controller.signal, onSwitch)).status).toBe(
      "failed",
    );
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(requests.filter((request) => request.method === "DELETE")).toEqual(
      [],
    );
  });

  it.each([PERSONAL, SHARED])(
    "completes an uninterrupted explicit handoff once for %s",
    async (source) => {
      const requests = fixture();
      const onSwitch = vi.fn();
      const outcome = await start(
        source,
        new AbortController().signal,
        onSwitch,
      );
      expect(outcome.status).toBe("switched");
      expect(onSwitch).toHaveBeenCalledTimes(1);
      expect(
        requests.filter((request) => request.url.endsWith("/cutover")),
      ).toHaveLength(source === PERSONAL ? 1 : 0);
      expect(
        requests.filter((request) => request.url.endsWith("/import")),
      ).toHaveLength(source === SHARED ? 1 : 0);
      expect(
        requests.filter((request) => request.method === "DELETE"),
      ).toHaveLength(source === SHARED ? 1 : 0);
    },
  );
});
