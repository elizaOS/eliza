/** Verifies the rowless personal-entry hook — the one-shot session-bound /join handoff channel, the authenticated resolution path through the real join flow onto a stubbed fetch transport (exact failure shapes: missing Steward token, unavailable identity endpoint, invalid identity), the retry:false/staleTime query policy, and the durable binding + first-run effects — through the package's configured test harness (jsdom, real renderHook, hand-rolled fetch stub; no module mocks). */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPersistedActiveServer,
  loadPersistedFirstRunComplete,
} from "../../state/persistence";
import type { JoinFlowResult } from "../join/lib/run-join-flow";
import {
  personalEntryBindingId,
  publishPersonalEntryHandoff,
  usePersonalEntry,
} from "./use-personal-entry";

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// A minimally-valid Steward JWT: readStoredStewardToken only base64-decodes
// the payload (userId + a future exp); no signature check.
function makeStewardToken(userId: string): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({
      userId,
      email: `${userId}@b.test`,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "sig",
  ].join(".");
}

function signInAs(token: string): void {
  localStorage.setItem(STEWARD_TOKEN_KEY, token);
}

interface PersonalCall {
  url: string;
  authorization: string | null;
}

const realFetch = globalThis.fetch;
let personalCalls: PersonalCall[];

function stubNetwork(personal?: () => Response): void {
  personalCalls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (personal && url.endsWith("/api/v1/eliza/personal")) {
      personalCalls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Promise.resolve(personal());
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: `unstubbed ${url}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";

function sharedIdentityOk(): () => Response {
  return () =>
    jsonResponse(200, {
      success: true,
      data: {
        identity: {
          id: PERSONAL_ID,
          displayName: "Eliza",
          runtime: "shared",
        },
      },
    });
}

// What the real runJoinFlow returns for the stubbed shared identity above:
// the id triple collapses onto the personal id and the shared REST base is
// built from the default direct-cloud origin with the encoded agent id.
function networkResolution(): JoinFlowResult {
  return {
    personalElizaId: PERSONAL_ID,
    agentId: PERSONAL_ID,
    activeAgentId: PERSONAL_ID,
    agentName: "Eliza",
    apiBase: `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}`,
    runtime: "shared",
  };
}

const HANDOFF_RESULT: JoinFlowResult = {
  personalElizaId: PERSONAL_ID,
  agentId: PERSONAL_ID,
  activeAgentId: "00000000-0000-4000-8000-000000000002",
  agentName: "Handoff Eliza",
  apiBase: "https://shared.eliza.app",
  runtime: "shared",
};

function renderPersonalEntry(options?: {
  enabled?: boolean;
  queryClient?: QueryClient;
}) {
  const queryClient =
    options?.queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }
  const rendered = renderHook(
    () => usePersonalEntry(options?.enabled ?? true),
    {
      wrapper,
    },
  );
  return { ...rendered, queryClient };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = realFetch;
});

describe("personalEntryBindingId", () => {
  it("binds the resolved personal Eliza under the cloud: namespace keyed by its agent id", () => {
    expect(personalEntryBindingId(HANDOFF_RESULT)).toBe(`cloud:${PERSONAL_ID}`);
  });

  it("distinct agents bind under distinct ids", () => {
    const other: JoinFlowResult = {
      ...HANDOFF_RESULT,
      agentId: "personal:ffffffff-0000-5000-8000-000000000009",
    };
    expect(personalEntryBindingId(other)).not.toBe(
      personalEntryBindingId(HANDOFF_RESULT),
    );
  });
});

describe("usePersonalEntry — enabled gate", () => {
  it("enabled=false holds the query idle with zero Cloud traffic even when signed in", async () => {
    signInAs(makeStewardToken("u1"));
    stubNetwork(sharedIdentityOk());

    const { result } = renderPersonalEntry({ enabled: false });
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));

    expect(result.current.status).toBe("pending");
    expect(result.current.data).toBeUndefined();
    expect(personalCalls).toEqual([]);
  });
});

describe("usePersonalEntry — one-shot session-bound handoff", () => {
  it("consumes a matching-session handoff in place without calling the identity endpoint", async () => {
    const token = makeStewardToken("u1");
    signInAs(token);
    publishPersonalEntryHandoff(token, HANDOFF_RESULT);
    stubNetwork(sharedIdentityOk());

    const { result } = renderPersonalEntry();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(HANDOFF_RESULT);
    expect(result.current.data?.agentName).toBe("Handoff Eliza");
    expect(personalCalls).toEqual([]);
  });

  it("a consumed receipt is single-use: the next consumer resolves through the network", async () => {
    const token = makeStewardToken("u1");
    signInAs(token);
    publishPersonalEntryHandoff(token, HANDOFF_RESULT);
    stubNetwork(sharedIdentityOk());

    const first = renderPersonalEntry();
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(first.result.current.data).toEqual(HANDOFF_RESULT);
    expect(personalCalls).toEqual([]);
    first.unmount();

    // A fresh query cache re-runs the queryFn; the receipt must be gone, so
    // resolution now goes through the real join-flow transport.
    const second = renderPersonalEntry();
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(second.result.current.data).toEqual(networkResolution());
    expect(personalCalls).toHaveLength(1);
  });

  it("a mismatched-session receipt is discarded once and cannot be replayed by its rightful owner later", async () => {
    const staleToken = makeStewardToken("stale");
    publishPersonalEntryHandoff(staleToken, HANDOFF_RESULT);

    const liveToken = makeStewardToken("live");
    signInAs(liveToken);
    stubNetwork(sharedIdentityOk());

    const first = renderPersonalEntry();
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(first.result.current.data).toEqual(networkResolution());
    expect(personalCalls).toEqual([
      {
        url: expect.stringContaining("/api/v1/eliza/personal"),
        authorization: `Bearer ${liveToken}`,
      },
    ]);
    first.unmount();

    // Even the publishing session gets nothing: the mismatched take already
    // destroyed the receipt, so a stale identity can never boot chat.
    signInAs(staleToken);
    const second = renderPersonalEntry();
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(second.result.current.data).toEqual(networkResolution());
    expect(personalCalls).toHaveLength(2);
    expect(personalCalls[1]?.authorization).toBe(`Bearer ${staleToken}`);
  });
});

describe("usePersonalEntry — resolution", () => {
  it("without a Steward session the query errors with the entry-gate message and sends nothing", async () => {
    stubNetwork(sharedIdentityOk());

    const { result } = renderPersonalEntry();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
    expect((result.current.error as Error).message).toBe(
      "PersonalEntry: no Steward session token for an authenticated entry.",
    );
    expect(personalCalls).toEqual([]);
    expect(loadPersistedActiveServer()).toBeNull();
  });

  it("resolves the authoritative binding through the real join flow and persists it", async () => {
    const token = makeStewardToken("u1");
    signInAs(token);
    stubNetwork(sharedIdentityOk());

    const { result } = renderPersonalEntry();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(networkResolution());
    expect(personalCalls).toEqual([
      {
        url: expect.stringContaining("/api/v1/eliza/personal"),
        authorization: `Bearer ${token}`,
      },
    ]);

    const server = loadPersistedActiveServer();
    expect(server?.id).toBe(`cloud:${PERSONAL_ID}`);
    expect(server?.accessToken).toBe(token);
    expect(loadPersistedFirstRunComplete()).toBe(true);
  });

  it("an unavailable identity endpoint errors after exactly one attempt (retry: false) and persists nothing", async () => {
    const token = makeStewardToken("u1");
    signInAs(token);
    stubNetwork(() => jsonResponse(503, { error: "down" }));

    const { result } = renderPersonalEntry();

    await waitFor(() => expect(result.current.isError).toBe(true));
    // No retry storm: the entry gate must fall back to /join promptly.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(personalCalls).toHaveLength(1);
    expect(loadPersistedActiveServer()).toBeNull();
    expect(loadPersistedFirstRunComplete()).toBe(false);
  });

  it("an invalid identity payload errors before any binding or completion bit is persisted", async () => {
    const token = makeStewardToken("u1");
    signInAs(token);
    stubNetwork(() =>
      jsonResponse(200, {
        success: true,
        data: {
          identity: {
            id: "not-a-personal-id",
            displayName: "Eliza",
            runtime: "shared",
          },
        },
      }),
    );

    const { result } = renderPersonalEntry();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe(
      "Eliza Cloud returned an invalid personal Eliza identity.",
    );
    expect(personalCalls).toHaveLength(1);
    expect(loadPersistedActiveServer()).toBeNull();
    expect(loadPersistedFirstRunComplete()).toBe(false);
  });

  it("staleTime=Infinity serves repeat mounts from cache without re-resolving", async () => {
    const token = makeStewardToken("u1");
    signInAs(token);
    stubNetwork(sharedIdentityOk());

    const first = renderPersonalEntry();
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(personalCalls).toHaveLength(1);
    first.unmount();

    const second = renderPersonalEntry({
      queryClient: first.queryClient,
    });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(second.result.current.data).toEqual(networkResolution());
    expect(personalCalls).toHaveLength(1);
  });
});
