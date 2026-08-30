/**
 * Behavioural coverage for the approvals cloud data layer, exercised through
 * the real React Query hooks with only the network boundary (`api`) and the
 * Steward session mocked. Pins request shaping (paths, encoding, JSON bodies),
 * response unwrapping, vote-error mapping, auth gating, and timestamp
 * formatting exactly as shipped.
 */
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let apiMockImpl: (path: string, options?: unknown) => Promise<unknown> =
  async () => {
    throw new Error("api mock not configured for this test");
  };

let sessionState: {
  ready: boolean;
  authenticated: boolean;
  user: { id: string; email: string } | null;
} = {
  ready: true,
  authenticated: true,
  user: { id: "user-approvals", email: "user-approvals@example.test" },
};

vi.mock("../../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api-client")>(
    "../../lib/api-client",
  );
  return {
    ...actual,
    api: (path: string, options?: unknown) => apiMockImpl(path, options),
  };
});
vi.mock("../../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionState,
}));

import type { ApprovalRequest, Ballot, SensitiveRequest } from "./approvals";
import {
  formatApprovalTimestamp,
  useApprovalRequests,
  useApproveRequest,
  useBallots,
  useCancelBallot,
  useCancelSensitiveRequest,
  useDenyRequest,
  useSensitiveRequest,
  useTallyBallot,
  useVoteBallot,
} from "./approvals";

function approvalRequestFixture(): ApprovalRequest {
  return {
    id: "req-1",
    organizationId: "org-1",
    agentId: null,
    userId: "user-approvals",
    challengeKind: "signature",
    challengePayload: {
      message: "sign me",
      signerKind: "wallet",
      walletAddress: "0xabc",
    },
    expectedSignerIdentityId: "ident-1",
    status: "pending",
    signatureText: null,
    signedAt: null,
    expiresAt: "2026-12-31T23:59:59Z",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    metadata: {},
  };
}

function ballotFixture(): Ballot {
  return {
    id: "ballot-1",
    organizationId: "org-1",
    agentId: null,
    purpose: "upgrade agent",
    participants: [{ identityId: "ident-1", label: "Owner" }],
    threshold: 2,
    status: "open",
    tallyResult: null,
    expiresAt: "2026-12-31T23:59:59Z",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    metadata: {},
  };
}

function sensitiveRequestFixture(): SensitiveRequest {
  return {
    id: "sr-1",
    kind: "secret",
    status: "pending",
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
}

function queryWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

beforeEach(() => {
  apiMockImpl = async () => {
    throw new Error("api mock not configured for this test");
  };
  sessionState = {
    ready: true,
    authenticated: true,
    user: { id: "user-approvals", email: "user-approvals@example.test" },
  };
});

afterEach(() => {
  cleanup();
});

describe("formatApprovalTimestamp", () => {
  it("returns null for a missing value", () => {
    expect(formatApprovalTimestamp(null)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(formatApprovalTimestamp("")).toBeNull();
  });

  it("returns null for a value Date cannot parse", () => {
    expect(formatApprovalTimestamp("definitely-not-a-date")).toBeNull();
  });

  it("formats a parseable UTC timestamp as a short en-US label", () => {
    // TZ=UTC is pinned by vitest.setup.ts; observed output on that clock.
    expect(formatApprovalTimestamp("2026-03-05T13:45:00Z")).toBe(
      "Mar 5, 1:45 PM",
    );
  });
});

describe("useApprovalRequests", () => {
  it("fetches the owner list without a query string when unfiltered and unwraps approvalRequests", async () => {
    const fixture = approvalRequestFixture();
    let calls = 0;
    apiMockImpl = async () => {
      calls += 1;
      return { success: true, approvalRequests: [fixture] };
    };
    const client = createQueryClient();

    const { result } = renderHook(() => useApprovalRequests(), {
      wrapper: queryWrapper(client),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([fixture]);
    });
    expect(calls).toBe(1);
  });

  it("appends the encoded status filter to the endpoint path", async () => {
    let requestedPath = "";
    apiMockImpl = async (path) => {
      requestedPath = path;
      return { success: true, approvalRequests: [] };
    };

    const { result } = renderHook(
      () => useApprovalRequests({ status: "pending" }),
      { wrapper: queryWrapper(createQueryClient()) },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
    expect(requestedPath).toBe("/api/v1/approval-requests?status=pending");
  });

  it("stays idle and never hits the API while signed out", () => {
    sessionState = {
      ready: true,
      authenticated: false,
      user: null,
    };
    let calls = 0;
    apiMockImpl = async () => {
      calls += 1;
      return { success: true, approvalRequests: [] };
    };

    const { result } = renderHook(() => useApprovalRequests(), {
      wrapper: queryWrapper(createQueryClient()),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(calls).toBe(0);
  });
});

describe("useApproveRequest", () => {
  it("POSTs the signature to the encoded approve endpoint and resolves the updated request", async () => {
    const fixture = approvalRequestFixture();
    let calledPath = "";
    let calledOptions: unknown;
    apiMockImpl = async (path, options) => {
      calledPath = path;
      calledOptions = options;
      return { success: true, approvalRequest: fixture };
    };

    const { result } = renderHook(() => useApproveRequest(), {
      wrapper: queryWrapper(createQueryClient()),
    });

    const approved = await result.current.mutateAsync({
      id: "req/7",
      signature: "0xsig",
    });

    expect(approved).toEqual(fixture);
    expect(calledPath).toBe("/api/v1/approval-requests/req%2F7/approve");
    expect(calledOptions).toEqual({
      method: "POST",
      json: { signature: "0xsig" },
    });
  });
});

describe("useDenyRequest", () => {
  it("submits the caller's reason verbatim", async () => {
    const fixture = approvalRequestFixture();
    let calledOptions: unknown;
    apiMockImpl = async (_path, options) => {
      calledOptions = options;
      return { success: true, approvalRequest: fixture };
    };

    const { result } = renderHook(() => useDenyRequest(), {
      wrapper: queryWrapper(createQueryClient()),
    });

    await result.current.mutateAsync({
      id: "req-1",
      signature: "0xsig",
      reason: "wrong agent",
    });

    expect(calledOptions).toEqual({
      method: "POST",
      json: { reason: "wrong agent", signature: "0xsig" },
    });
  });

  it("falls back to the default owner denial reason when none is given", async () => {
    let calledOptions: unknown;
    apiMockImpl = async (_path, options) => {
      calledOptions = options;
      return { success: true, approvalRequest: approvalRequestFixture() };
    };

    const { result } = renderHook(() => useDenyRequest(), {
      wrapper: queryWrapper(createQueryClient()),
    });

    await result.current.mutateAsync({ id: "req-1", signature: "0xsig" });

    expect(calledOptions).toEqual({
      method: "POST",
      json: { reason: "denied by owner", signature: "0xsig" },
    });
  });
});

describe("useBallots", () => {
  it("fetches ballots with the encoded status filter and unwraps ballots", async () => {
    const fixture = ballotFixture();
    let requestedPath = "";
    apiMockImpl = async (path) => {
      requestedPath = path;
      return { success: true, ballots: [fixture] };
    };

    const { result } = renderHook(() => useBallots({ status: "open" }), {
      wrapper: queryWrapper(createQueryClient()),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual([fixture]);
    });
    expect(requestedPath).toBe("/api/v1/ballots?status=open");
  });
});

describe("useVoteBallot", () => {
  it("resolves the recorded outcome on success", async () => {
    let calledPath = "";
    let calledOptions: unknown;
    apiMockImpl = async (path, options) => {
      calledPath = path;
      calledOptions = options;
      return { success: true, outcome: "recorded", ballotStatus: "open" };
    };

    const { result } = renderHook(() => useVoteBallot(), {
      wrapper: queryClientWrapper(),
    });

    const response = await result.current.mutateAsync({
      id: "ballot-1",
      scopedToken: "tok",
      value: "yes",
    });

    expect(response).toEqual({
      success: true,
      outcome: "recorded",
      ballotStatus: "open",
    });
    expect(calledPath).toBe("/api/v1/ballots/ballot-1/vote");
    expect(calledOptions).toEqual({
      method: "POST",
      json: { scopedToken: "tok", value: "yes" },
    });
  });

  it("rejects with the server-provided error message when the vote fails", async () => {
    apiMockImpl = async () => ({
      success: false,
      error: "Quorum not met",
    });

    const { result } = renderHook(() => useVoteBallot(), {
      wrapper: queryClientWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        id: "ballot-1",
        scopedToken: "tok",
        value: "yes",
      }),
    ).rejects.toThrow("Quorum not met");
  });

  it("rejects with the fallback message when the failure carries no error text", async () => {
    apiMockImpl = async () => ({ success: false });

    const { result } = renderHook(() => useVoteBallot(), {
      wrapper: queryClientWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        id: "ballot-1",
        scopedToken: "tok",
        value: "yes",
      }),
    ).rejects.toThrow("Unable to record vote.");
  });
});

describe("useTallyBallot", () => {
  it("POSTs an empty body and returns the tally response unchanged", async () => {
    const ballot = ballotFixture();
    let calledPath = "";
    let calledOptions: unknown;
    apiMockImpl = async (path, options) => {
      calledPath = path;
      calledOptions = options;
      return {
        success: true,
        tallied: false,
        ballot,
        tallyResult: null,
      };
    };

    const { result } = renderHook(() => useTallyBallot(), {
      wrapper: queryClientWrapper(),
    });

    const response = await result.current.mutateAsync({ id: "ballot-1" });

    expect(response).toEqual({
      success: true,
      tallied: false,
      ballot,
      tallyResult: null,
    });
    expect(calledPath).toBe("/api/v1/ballots/ballot-1/tally");
    expect(calledOptions).toEqual({ method: "POST", json: {} });
  });
});

describe("useCancelBallot", () => {
  it("returns the cancelled ballot and always sends a reason field", async () => {
    const fixture = { ...ballotFixture(), status: "canceled" as const };
    let calledJson: unknown;
    apiMockImpl = async (_path, options) => {
      calledJson = (options as { json?: unknown })?.json;
      return { success: true, ballot: fixture };
    };

    const { result } = renderHook(() => useCancelBallot(), {
      wrapper: queryClientWrapper(),
    });

    const cancelled = await result.current.mutateAsync({ id: "ballot-1" });

    expect(cancelled).toEqual(fixture);
    expect("reason" in (calledJson as Record<string, unknown>)).toBe(true);
  });
});

describe("useSensitiveRequest", () => {
  it("stays disabled for a null id and never calls the API", () => {
    let calls = 0;
    apiMockImpl = async () => {
      calls += 1;
      return sensitiveRequestFixture();
    };

    const { result } = renderHook(() => useSensitiveRequest(null), {
      wrapper: queryClientWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.isEnabled).toBe(false);
    expect(calls).toBe(0);
  });

  it("treats a whitespace-only id as empty and stays disabled", () => {
    let calls = 0;
    apiMockImpl = async () => {
      calls += 1;
      return sensitiveRequestFixture();
    };

    const { result } = renderHook(() => useSensitiveRequest("   "), {
      wrapper: queryClientWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(calls).toBe(0);
  });

  it("trims the id before requesting its detail endpoint", async () => {
    const fixture = sensitiveRequestFixture();
    let requestedPath = "";
    apiMockImpl = async (path) => {
      requestedPath = path;
      return fixture;
    };

    const { result } = renderHook(() => useSensitiveRequest("  sr-42  "), {
      wrapper: queryClientWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(fixture);
    });
    expect(requestedPath).toBe("/api/v1/sensitive-requests/sr-42");
  });

  it("unwraps a { request } envelope payload", async () => {
    const fixture = sensitiveRequestFixture();
    apiMockImpl = async () => ({ request: fixture });

    const { result } = renderHook(() => useSensitiveRequest("sr-1"), {
      wrapper: queryClientWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(fixture);
    });
  });

  it("passes a plain sensitive-request payload through untouched", async () => {
    const fixture = sensitiveRequestFixture();
    apiMockImpl = async () => fixture;

    const { result } = renderHook(() => useSensitiveRequest("sr-1"), {
      wrapper: queryClientWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(fixture);
    });
  });
});

describe("useCancelSensitiveRequest", () => {
  it("POSTs an empty cancel body and resolves the returned request", async () => {
    const fixture = {
      ...sensitiveRequestFixture(),
      status: "canceled" as const,
    };
    let calledPath = "";
    let calledOptions: unknown;
    apiMockImpl = async (path, options) => {
      calledPath = path;
      calledOptions = options;
      return { success: true, request: fixture };
    };

    const { result } = renderHook(() => useCancelSensitiveRequest(), {
      wrapper: queryClientWrapper(),
    });

    const cancelled = await result.current.mutateAsync({ id: "sr/9" });

    expect(cancelled).toEqual(fixture);
    expect(calledPath).toBe("/api/v1/sensitive-requests/sr%2F9/cancel");
    expect(calledOptions).toEqual({ method: "POST", json: {} });
  });
});

function queryClientWrapper(): (props: { children: ReactNode }) => ReactNode {
  return queryWrapper(createQueryClient());
}
