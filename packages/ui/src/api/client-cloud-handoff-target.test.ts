/**
 * Unit coverage for cloud handoff-target resolution. Capacitor mocked, no live
 * cloud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, registerPlugin: () => ({}) },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
// Side-effect import: patches startCloudAgentHandoff onto the prototype.
import "./client-cloud";
import type { CloudCompatAgent } from "./client-types-cloud";
import { DEFAULT_DIRECT_CLOUD_API_BASE_URL } from "./direct-cloud-endpoints";

/**
 * Phase 1 (create-both): the shared agent the user chats on is container-free
 * and never grows a dedicated base, so the handoff readiness probe must poll a
 * SEPARATE dedicated agent. `dedicatedAgentId` selects that target; omitting it
 * keeps the pre-shared-tier behavior (poll the same `agentId`). These tests pin
 * which agent id the probe reads from.
 */

function runningDedicated(
  overrides: Partial<CloudCompatAgent> = {},
): CloudCompatAgent {
  return {
    agent_id: "dedicated-1",
    agent_name: "Eliza",
    node_id: null,
    container_id: null,
    headscale_ip: null,
    bridge_url: null,
    web_ui_url: "https://dedicated-1.elizacloud.ai",
    status: "running",
    agent_config: {},
    created_at: "2026-06-27T00:00:00.000Z",
    updated_at: "2026-06-27T00:00:00.000Z",
    containerUrl: "",
    webUiUrl: "https://dedicated-1.elizacloud.ai",
    database_status: "ok",
    error_message: null,
    last_heartbeat_at: null,
    ...overrides,
  };
}

function fakeClient(detailById: Record<string, CloudCompatAgent>) {
  const getCloudCompatAgent = vi.fn(async (id: string) => {
    const data = detailById[id];
    return data ? { success: true, data } : { success: false, data: null };
  });
  const client = Object.create(ElizaClient.prototype) as ElizaClient;
  Object.assign(client, { getCloudCompatAgent });
  return { client, getCloudCompatAgent };
}

const SHARED_BASE = "https://elizacloud.ai/api/v1/eliza/agents/shared-1/api";

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 30_000;
/** Bound on advances so a guard regression fails the assertion, never hangs. */
const MAX_POLL_ADVANCES = 50;
/** Polls whose detail response must be handled before the budget may expire. */
const MIN_OBSERVED_DETAIL_READS = 3;

/**
 * Drive a rejection case on a controlled clock.
 *
 * A short real-time deadline can satisfy "the readiness probe never ran" by
 * simply expiring before the detail response is handled, which observes the
 * worker's speed rather than the guard. Fake timers make every poll explicit:
 * advance one interval at a time until the target's detail endpoint has been
 * read and handled `MIN_OBSERVED_DETAIL_READS` times — so the rejection is
 * known to have been decided on real, handled responses — and only then let
 * the budget expire. The returned `detailReads` is the observation taken
 * before the deadline, so each caller can assert on it.
 */
async function runRejectedHandoff<T extends { status: string }>(options: {
  start: () => Promise<T>;
  detailReads: () => number;
}): Promise<{ result: T; detailReads: number }> {
  vi.useFakeTimers();
  try {
    const pending = options.start();
    for (
      let advance = 0;
      advance < MAX_POLL_ADVANCES &&
      options.detailReads() < MIN_OBSERVED_DETAIL_READS;
      advance += 1
    ) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    }
    const detailReads = options.detailReads();
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
    return { result: await pending, detailReads };
  } finally {
    vi.useRealTimers();
  }
}

describe("startCloudAgentHandoff — dedicated migration target", () => {
  // The handoff reads the shared conversation over `fetch` (authedFetch). Stub
  // it to an empty conversation so the flow reaches the switch without import —
  // these tests only pin which agent the readiness probe targets.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => ({
        status: 200,
        json: async () => {
          const match = String(input).match(
            /\/api\/v1\/eliza\/agents\/([^/]+)$/,
          );
          if (match) {
            const id = decodeURIComponent(match[1] ?? "");
            return {
              success: true,
              data: { ...runningDedicated({ agent_id: id }), id },
            };
          }
          return { messages: [] };
        },
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls the SEPARATE dedicated agent, not the shared source", async () => {
    // Only the dedicated agent ever exposes a base; the shared one stays
    // container-free. The probe must read the dedicated id or it never resolves.
    const { client, getCloudCompatAgent } = fakeClient({
      "dedicated-1": runningDedicated(),
    });

    const onSwitch = vi.fn();
    const result = await client.startCloudAgentHandoff({
      agentId: "shared-1",
      sharedApiBase: SHARED_BASE,
      conversationId: "shared-1",
      dedicatedAgentId: "dedicated-1",
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "tok",
      onSwitch,
      intervalMs: 1,
      timeoutMs: 200,
      // No shared messages → switch without import; we only assert the target.
      log: () => {},
    });

    expect(getCloudCompatAgent).not.toHaveBeenCalled();
    expect(getCloudCompatAgent).not.toHaveBeenCalledWith("shared-1");
    expect(fetch).toHaveBeenCalledWith(
      `${DEFAULT_DIRECT_CLOUD_API_BASE_URL}/api/v1/eliza/agents/dedicated-1`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
    expect(onSwitch).toHaveBeenCalledWith("https://dedicated-1.elizacloud.ai");
    expect(
      result.status === "switched" || result.status === "switched-empty",
    ).toBe(true);
  });

  it("defaults to polling `agentId` when no dedicated target is given", async () => {
    const { client, getCloudCompatAgent } = fakeClient({
      "agent-self": runningDedicated({
        agent_id: "agent-self",
        web_ui_url: "https://agent-self.elizacloud.ai",
        webUiUrl: "https://agent-self.elizacloud.ai",
      }),
    });

    await client.startCloudAgentHandoff({
      agentId: "agent-self",
      sharedApiBase: SHARED_BASE,
      conversationId: "agent-self",
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "tok",
      onSwitch: vi.fn(),
      intervalMs: 1,
      timeoutMs: 200,
      log: () => {},
    });

    expect(getCloudCompatAgent).not.toHaveBeenCalled();
    // The poll this test is named for: absent a dedicated target, the probe
    // must read `agentId` — an assertion that fails if the probe short-circuits
    // to null instead of polling at all.
    expect(fetch).toHaveBeenCalledWith(
      `${DEFAULT_DIRECT_CLOUD_API_BASE_URL}/api/v1/eliza/agents/agent-self`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("still switches when the source IS a shared adapter and a dedicated target is given", async () => {
    // The Phase-1 migration itself: shared-adapter source plus a separately
    // provisioned dedicated target. Guards the `!dedicatedAgentId` term of the
    // short-circuit — without it every real handoff times out.
    const adapterBase =
      "https://elizacloud.ai/api/v1/eliza/agents/00000000-0000-4000-8000-00000000000a";
    const { client } = fakeClient({ "dedicated-1": runningDedicated() });
    const onSwitch = vi.fn();
    const result = await client.startCloudAgentHandoff({
      agentId: "shared-1",
      sharedApiBase: adapterBase,
      conversationId: "shared-1",
      dedicatedAgentId: "dedicated-1",
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "tok",
      onSwitch,
      intervalMs: 1,
      timeoutMs: 200,
      log: () => {},
    });

    expect(onSwitch).toHaveBeenCalledWith("https://dedicated-1.elizacloud.ai");
    expect(
      result.status === "switched" || result.status === "switched-empty",
    ).toBe(true);
  });

  it("uses the agent-scoped local Cloud proxy when no public agent URL exists", async () => {
    const dedicatedId = "00000000-0000-4000-8000-000000000001";
    const cloudApiBase = "http://127.0.0.1:8787";
    const localDedicatedBase = `${cloudApiBase}/api/v1/eliza/agents/${dedicatedId}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === localDedicatedBase) {
        return {
          status: 200,
          json: async () => ({
            success: true,
            data: {
              id: dedicatedId,
              status: "running",
              webUiUrl: null,
            },
          }),
        };
      }
      if (url === `${localDedicatedBase}/api/health`) {
        return { status: 200, json: async () => ({ ready: true }) };
      }
      if (url.endsWith("/messages")) {
        return { status: 200, json: async () => ({ messages: [] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { client } = fakeClient({});
    const onSwitch = vi.fn();
    const result = await client.startCloudAgentHandoff({
      agentId: "shared-1",
      sharedApiBase: SHARED_BASE,
      conversationId: "shared-1",
      dedicatedAgentId: dedicatedId,
      cloudApiBase,
      authToken: "tok",
      onSwitch,
      intervalMs: 1,
      timeoutMs: 200,
      log: () => {},
    });

    expect(result.status).toBe("switched-empty");
    expect(onSwitch).toHaveBeenCalledWith(localDedicatedBase);
  });

  it("does not treat a shared row on the local UUID proxy as dedicated", async () => {
    // `dedicatedAgentId` bypasses the shared-adapter short-circuit so this
    // case reaches the execution-tier check, and the mock answers the whole
    // switch path (detail, health, messages) so that check is the only thing
    // standing between this fixture and a completed switch.
    const dedicatedId = "00000000-0000-4000-8000-000000000001";
    const cloudApiBase = "http://127.0.0.1:8787";
    const localDedicatedBase = `${cloudApiBase}/api/v1/eliza/agents/${dedicatedId}`;
    let detailReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === localDedicatedBase) {
        detailReads += 1;
        return {
          status: 200,
          json: async () => ({
            success: true,
            data: {
              id: dedicatedId,
              status: "running",
              executionTier: "shared",
              webUiUrl: null,
            },
          }),
        };
      }
      if (url === `${localDedicatedBase}/api/health`) {
        return { status: 200, json: async () => ({ ready: true }) };
      }
      if (url.endsWith("/messages")) {
        return { status: 200, json: async () => ({ messages: [] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { client } = fakeClient({});
    const onSwitch = vi.fn();
    const { result, detailReads: observedReads } = await runRejectedHandoff({
      detailReads: () => detailReads,
      start: () =>
        client.startCloudAgentHandoff({
          agentId: "shared-1",
          sharedApiBase: SHARED_BASE,
          conversationId: "shared-1",
          dedicatedAgentId: dedicatedId,
          cloudApiBase,
          authToken: "tok",
          onSwitch,
          intervalMs: POLL_INTERVAL_MS,
          timeoutMs: POLL_TIMEOUT_MS,
          log: () => {},
        }),
    });

    // The tier check rejected handled detail responses, repeatedly — the
    // deadline is not what kept the readiness probe away from this base.
    expect(observedReads).toBeGreaterThanOrEqual(MIN_OBSERVED_DETAIL_READS);
    expect(result.status).toBe("timed-out");
    expect(onSwitch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `${localDedicatedBase}/api/health`,
      expect.anything(),
    );
  });

  it("never switches a shared adapter in place when the control plane omits executionTier", async () => {
    // Older control planes omit `executionTier`, so the tier check cannot
    // stop this path; the shared-adapter short-circuit is the only guard.
    // The mock answers the whole switch path so that short-circuit is what
    // this fixture observes: without it the handoff switches in place.
    const sharedId = "00000000-0000-4000-8000-000000000002";
    const cloudApiBase = "http://127.0.0.1:8787";
    const localSharedBase = `${cloudApiBase}/api/v1/eliza/agents/${sharedId}`;
    // This guard short-circuits before any detail read, so the observable
    // poll is the shared conversation read the loop performs each interval.
    let pollReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === localSharedBase) {
        return {
          status: 200,
          json: async () => ({
            success: true,
            data: { id: sharedId, status: "running", webUiUrl: null },
          }),
        };
      }
      if (url === `${localSharedBase}/api/health`) {
        return { status: 200, json: async () => ({ ready: true }) };
      }
      if (url.endsWith("/messages")) {
        pollReads += 1;
        return { status: 200, json: async () => ({ messages: [] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { client } = fakeClient({});
    const onSwitch = vi.fn();
    const { result } = await runRejectedHandoff({
      detailReads: () => pollReads,
      start: () =>
        client.startCloudAgentHandoff({
          agentId: sharedId,
          sharedApiBase: localSharedBase,
          conversationId: sharedId,
          cloudApiBase,
          authToken: "tok",
          onSwitch,
          intervalMs: POLL_INTERVAL_MS,
          timeoutMs: POLL_TIMEOUT_MS,
          log: () => {},
        }),
    });

    // The short-circuit refuses before the base is ever read, so the control
    // here is the negative one: the whole budget elapsed without the detail
    // endpoint being contacted even once.
    expect(result.status).toBe("timed-out");
    expect(onSwitch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      localSharedBase,
      expect.anything(),
    );
  });

  it("does not treat a production control-plane UUID path as a dedicated handoff target", async () => {
    const dedicatedId = "00000000-0000-4000-8000-000000000001";
    const cloudApiBase = DEFAULT_DIRECT_CLOUD_API_BASE_URL;
    const productionSharedBase = `${cloudApiBase}/api/v1/eliza/agents/${dedicatedId}`;
    let detailReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === productionSharedBase) {
        detailReads += 1;
        return {
          status: 200,
          json: async () => ({
            success: true,
            data: { id: dedicatedId, status: "running", webUiUrl: null },
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { client } = fakeClient({});
    const onSwitch = vi.fn();
    const { result, detailReads: observedReads } = await runRejectedHandoff({
      detailReads: () => detailReads,
      start: () =>
        client.startCloudAgentHandoff({
          agentId: "shared-1",
          sharedApiBase: SHARED_BASE,
          conversationId: "shared-1",
          dedicatedAgentId: dedicatedId,
          cloudApiBase,
          authToken: "tok",
          onSwitch,
          intervalMs: POLL_INTERVAL_MS,
          timeoutMs: POLL_TIMEOUT_MS,
          log: () => {},
        }),
    });

    // Handled detail responses, repeatedly rejected: the control-plane UUID
    // path was refused on its merits, not left unreached by a short deadline.
    expect(observedReads).toBeGreaterThanOrEqual(MIN_OBSERVED_DETAIL_READS);
    expect(result.status).toBe("timed-out");
    expect(onSwitch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `${productionSharedBase}/api/health`,
      expect.anything(),
    );
  });

  it("never switches onto a control-plane shared REST base that the record advertises as its web UI", async () => {
    // Folded in from #30377 so this suite keeps one guard set. The sibling
    // cases all stop earlier: `webUiUrl: null` means the record carries no
    // dedicated URL at all, so `hasDedicatedUrl` rejects them before the base
    // is ever classified. Here the record *does* advertise a URL and reports a
    // dedicated tier, so `!agent`, `execution_tier`, `hasDedicatedUrl` and the
    // `status !== "running"` checks all pass -- and the URL it advertises is
    // the control-plane shared REST adapter, which is exactly what
    // `isDirectCloudSharedAgentBase(base) && !isLocalDedicatedProxy` exists to
    // refuse. The mock answers the whole switch path, so without that guard the
    // handoff completes onto a base that hosts no dedicated runtime.
    const dedicatedId = "00000000-0000-4000-8000-000000000003";
    const cloudApiBase = DEFAULT_DIRECT_CLOUD_API_BASE_URL;
    const sharedRestBase = `${cloudApiBase}/api/v1/eliza/agents/${dedicatedId}`;
    let detailReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === sharedRestBase) {
        detailReads += 1;
        return {
          status: 200,
          json: async () => ({
            success: true,
            data: {
              id: dedicatedId,
              status: "running",
              executionTier: "dedicated",
              webUiUrl: sharedRestBase,
            },
          }),
        };
      }
      if (url === `${sharedRestBase}/api/health`) {
        return { status: 200, json: async () => ({ ready: true }) };
      }
      if (url.endsWith("/messages")) {
        return { status: 200, json: async () => ({ messages: [] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { client } = fakeClient({});
    const onSwitch = vi.fn();
    const { result, detailReads: observedReads } = await runRejectedHandoff({
      detailReads: () => detailReads,
      start: () =>
        client.startCloudAgentHandoff({
          agentId: "shared-1",
          sharedApiBase: SHARED_BASE,
          conversationId: "shared-1",
          dedicatedAgentId: dedicatedId,
          cloudApiBase,
          authToken: "tok",
          onSwitch,
          intervalMs: POLL_INTERVAL_MS,
          timeoutMs: POLL_TIMEOUT_MS,
          log: () => {},
        }),
    });

    // Every advertised-URL response was handled and refused; the base is
    // never probed for readiness, so the switch cannot land on it.
    expect(observedReads).toBeGreaterThanOrEqual(MIN_OBSERVED_DETAIL_READS);
    expect(result.status).toBe("timed-out");
    expect(onSwitch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `${sharedRestBase}/api/health`,
      expect.anything(),
    );
  });
});

describe("startCloudAgentHandoff — proxy-readiness gate (#15901)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does NOT declare the base ready while the runtime proxy 404s a `running` agent, then lands once it routes", async () => {
    const { client } = fakeClient({ "dedicated-1": runningDedicated() });

    // Control-plane record says running + URL set from the first poll, but the
    // subdomain 404s (router not registered yet) for the first probes — the
    // exact window seen on device in #15901.
    let healthProbes = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        healthProbes += 1;
        return {
          status: healthProbes < 3 ? 404 : 200,
          json: async () => ({}),
        };
      }
      if (url.endsWith("/messages")) {
        return { status: 200, json: async () => ({ messages: [] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onSwitch = vi.fn();
    const result = await client.startCloudAgentHandoff({
      agentId: "shared-1",
      sharedApiBase: SHARED_BASE,
      conversationId: "shared-1",
      dedicatedAgentId: "dedicated-1",
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "tok",
      onSwitch,
      intervalMs: 1,
      timeoutMs: 2_000,
      log: () => {},
    });

    expect(healthProbes).toBe(3);
    expect(onSwitch).toHaveBeenCalledWith("https://dedicated-1.elizacloud.ai");
    expect(result.status).toBe("switched-empty");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://dedicated-1.elizacloud.ai/api/health",
      expect.anything(),
    );
  });

  it("treats a routed auth challenge (401) as routable — the import carries its own credentials", async () => {
    const { client } = fakeClient({ "dedicated-1": runningDedicated() });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return { status: 401, json: async () => ({}) };
        }
        return { status: 200, json: async () => ({ messages: [] }) };
      }),
    );

    const onSwitch = vi.fn();
    const result = await client.startCloudAgentHandoff({
      agentId: "shared-1",
      sharedApiBase: SHARED_BASE,
      conversationId: "shared-1",
      dedicatedAgentId: "dedicated-1",
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "tok",
      onSwitch,
      intervalMs: 1,
      timeoutMs: 500,
      log: () => {},
    });

    expect(onSwitch).toHaveBeenCalledWith("https://dedicated-1.elizacloud.ai");
    expect(result.status).toBe("switched-empty");
  });

  it("treats a network-layer fetch failure as not-yet-routable, then lands once the probe stops throwing", async () => {
    const { client } = fakeClient({ "dedicated-1": runningDedicated() });

    let healthProbes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          healthProbes += 1;
          if (healthProbes < 2) throw new TypeError("Failed to fetch");
          return { status: 200, json: async () => ({}) };
        }
        return { status: 200, json: async () => ({ messages: [] }) };
      }),
    );

    const onSwitch = vi.fn();
    const result = await client.startCloudAgentHandoff({
      agentId: "shared-1",
      sharedApiBase: SHARED_BASE,
      conversationId: "shared-1",
      dedicatedAgentId: "dedicated-1",
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "tok",
      onSwitch,
      intervalMs: 1,
      timeoutMs: 2_000,
      log: () => {},
    });

    expect(healthProbes).toBe(2);
    expect(onSwitch).toHaveBeenCalledWith("https://dedicated-1.elizacloud.ai");
    expect(result.status).toBe("switched-empty");
  });

  it("times out honestly (still on the shared adapter) when the proxy never routes", async () => {
    const { client } = fakeClient({ "dedicated-1": runningDedicated() });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/health")) {
          return { status: 404, json: async () => ({}) };
        }
        return { status: 200, json: async () => ({ messages: [] }) };
      }),
    );

    const onSwitch = vi.fn();
    const result = await client.startCloudAgentHandoff({
      agentId: "shared-1",
      sharedApiBase: SHARED_BASE,
      conversationId: "shared-1",
      dedicatedAgentId: "dedicated-1",
      cloudApiBase: "https://www.elizacloud.ai",
      authToken: "tok",
      onSwitch,
      intervalMs: 1,
      timeoutMs: 60,
      log: () => {},
    });

    expect(result.status).toBe("timed-out");
    expect(onSwitch).not.toHaveBeenCalled();
  });
});
