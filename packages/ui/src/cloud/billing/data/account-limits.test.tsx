/**
 * Deterministic contract tests for the account-limits envelope parser and
 * authenticated React Query hook. Network and session boundaries are mocked;
 * the real parser validates ready, partial, unavailable, and adversarial data.
 */
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const sessionState = vi.hoisted(() => ({
  current: {
    ready: false,
    authenticated: false,
    user: null as { id: string; email: string } | null,
  },
}));

vi.mock("../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {},
  api: apiMock,
}));
vi.mock("../../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionState.current,
}));

import {
  parseAccountLimitsEnvelope,
  useAccountLimitsSnapshot,
} from "./account-limits";
import { useBillingUser } from "./billing-data";

const OBSERVED_AT = "2026-08-16T10:20:30.000Z";
const INVALID_RESPONSE_MESSAGE = "Account limits response is invalid.";

function readyEnvelope(): Record<string, unknown> {
  return {
    success: true,
    data: {
      observedAt: OBSERVED_AT,
      cloudCharacters: {
        source: "cloud-character-quota",
        state: "available",
        used: 3,
        limit: 100,
      },
      agentSandboxes: {
        source: "agent-sandbox-quota",
        used: 2,
        nonEagerCreate: { state: "available", limit: 5 },
        eagerManagedCreate: { state: "available", limit: 100 },
        state: "available",
        // These deprecated aliases are deliberately contradictory/noisy: only
        // the required root state and the two create paths are authoritative.
        nonEagerCreateLimit: -1,
        eagerManagedCreateLimit: 1,
        reason: "deprecated alias must not become UI truth",
      },
      containers: {
        source: "container-quota",
        state: "at-limit",
        used: 10,
        limit: 10,
      },
      apps: {
        source: "apps-service",
        state: "available",
        used: 4,
        limit: 25,
      },
      storage: {
        source: "org-storage-quota",
        state: "available",
        bytesUsed: "123",
        bytesLimit: "5368709120",
      },
      inferenceRateLimits: {
        source: "org-rate-limits",
        state: "available",
        completionsRpm: 60,
        embeddingsRpm: 120,
      },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid test fixture record");
  }
  return value as Record<string, unknown>;
}

function dataOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return record(envelope.data);
}

function sectionOf(
  envelope: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return record(dataOf(envelope)[key]);
}

function partialEnvelope(): Record<string, unknown> {
  const envelope = structuredClone(readyEnvelope());
  const data = dataOf(envelope);
  data.containers = {
    source: "container-quota",
    state: "unavailable",
    reason: "source read failed",
  };
  data.agentSandboxes = {
    source: "agent-sandbox-quota",
    used: 2,
    nonEagerCreate: { state: "available", limit: 5 },
    eagerManagedCreate: {
      state: "unavailable",
      reason: "source read failed",
    },
    state: "unavailable",
  };
  return envelope;
}

function unavailableEnvelope(): Record<string, unknown> {
  const unavailableCounted = (source: string) => ({
    source,
    state: "unavailable",
    reason: "source read failed",
  });

  return {
    success: true,
    data: {
      observedAt: OBSERVED_AT,
      cloudCharacters: unavailableCounted("cloud-character-quota"),
      agentSandboxes: {
        source: "agent-sandbox-quota",
        nonEagerCreate: {
          state: "unavailable",
          reason: "source read failed",
        },
        eagerManagedCreate: {
          state: "unavailable",
          reason: "source read failed",
        },
        state: "unavailable",
      },
      containers: unavailableCounted("container-quota"),
      apps: unavailableCounted("apps-service"),
      storage: {
        source: "org-storage-quota",
        state: "unavailable",
        reason: "source read failed",
      },
      inferenceRateLimits: {
        source: "org-rate-limits",
        state: "unavailable",
        reason: "source read failed",
      },
    },
  };
}

type EnvelopeMutation = (envelope: Record<string, unknown>) => void;

const malformedCases: Array<[string, EnvelopeMutation]> = [
  [
    "rejects a false success envelope",
    (envelope) => {
      envelope.success = false;
    },
  ],
  [
    "rejects a non-canonical observation timestamp",
    (envelope) => {
      dataOf(envelope).observedAt = "backend-internal: sensitive reason";
    },
  ],
  [
    "rejects an empty source",
    (envelope) => {
      sectionOf(envelope, "cloudCharacters").source = "  ";
    },
  ],
  [
    "rejects an unknown state",
    (envelope) => {
      sectionOf(envelope, "apps").state = "healthy";
    },
  ],
  [
    "rejects an unsafe count",
    (envelope) => {
      sectionOf(envelope, "apps").used = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "rejects a zero counted limit",
    (envelope) => {
      sectionOf(envelope, "apps").limit = 0;
    },
  ],
  [
    "rejects unavailable counted data without a reason",
    (envelope) => {
      const apps = sectionOf(envelope, "apps");
      apps.state = "unavailable";
      delete apps.used;
      delete apps.limit;
    },
  ],
  [
    "rejects a counted state that contradicts usage",
    (envelope) => {
      sectionOf(envelope, "apps").state = "over-limit";
    },
  ],
  [
    "rejects a missing sandbox create path",
    (envelope) => {
      delete sectionOf(envelope, "agentSandboxes").eagerManagedCreate;
    },
  ],
  [
    "rejects a sandbox root alias that contradicts eager state",
    (envelope) => {
      sectionOf(envelope, "agentSandboxes").state = "over-limit";
    },
  ],
  [
    "rejects a ready sandbox path without usage",
    (envelope) => {
      delete sectionOf(envelope, "agentSandboxes").used;
    },
  ],
  [
    "rejects non-canonical storage decimals",
    (envelope) => {
      sectionOf(envelope, "storage").bytesUsed = "0123";
    },
  ],
  [
    "rejects storage state that contradicts exact bytes",
    (envelope) => {
      sectionOf(envelope, "storage").state = "over-limit";
    },
  ],
  [
    "rejects storage bytes on an unavailable item",
    (envelope) => {
      const storage = sectionOf(envelope, "storage");
      storage.state = "unavailable";
      storage.reason = "source read failed";
    },
  ],
  [
    "rejects a zero inference cap",
    (envelope) => {
      sectionOf(envelope, "inferenceRateLimits").completionsRpm = 0;
    },
  ],
  [
    "rejects an inference usage state the caps-only endpoint cannot observe",
    (envelope) => {
      sectionOf(envelope, "inferenceRateLimits").state = "at-limit";
    },
  ],
];

const ORG_ONE = "org-one";
const ORG_TWO = "org-two";

function authenticatedAs(userId: string): void {
  sessionState.current = {
    ready: true,
    authenticated: true,
    user: { id: userId, email: `${userId}@example.test` },
  };
}

function queryWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

beforeEach(() => {
  apiMock.mockReset();
  sessionState.current = {
    ready: false,
    authenticated: false,
    user: null,
  };
});

afterEach(() => {
  cleanup();
});

describe("parseAccountLimitsEnvelope", () => {
  it("parses a complete ready snapshot and drops deprecated sandbox aliases", () => {
    const parsed = parseAccountLimitsEnvelope(readyEnvelope());

    expect(parsed.observedAt).toBe(OBSERVED_AT);
    expect(parsed.cloudCharacters).toEqual({
      source: "cloud-character-quota",
      state: "available",
      used: 3,
      limit: 100,
    });
    expect(parsed.agentSandboxes).toEqual({
      source: "agent-sandbox-quota",
      used: 2,
      nonEagerCreate: { state: "available", limit: 5 },
      eagerManagedCreate: { state: "available", limit: 100 },
      state: "available",
    });
    expect(parsed.containers.state).toBe("at-limit");
  });

  it("preserves independent unavailable sections in a partial snapshot", () => {
    const parsed = parseAccountLimitsEnvelope(partialEnvelope());

    expect(parsed.cloudCharacters.state).toBe("available");
    expect(parsed.containers).toEqual({
      source: "container-quota",
      state: "unavailable",
      reason: "source read failed",
    });
    expect(parsed.agentSandboxes.used).toBe(2);
    expect(parsed.agentSandboxes.nonEagerCreate.state).toBe("available");
    expect(parsed.agentSandboxes.eagerManagedCreate).toEqual({
      state: "unavailable",
      reason: "source read failed",
    });
  });

  it("parses a fully unavailable snapshot without fabricating usage", () => {
    const parsed = parseAccountLimitsEnvelope(unavailableEnvelope());

    expect(parsed.cloudCharacters).toEqual({
      source: "cloud-character-quota",
      state: "unavailable",
      reason: "source read failed",
    });
    expect(parsed.agentSandboxes.used).toBeUndefined();
    expect(parsed.storage.bytesUsed).toBeUndefined();
    expect(parsed.inferenceRateLimits.completionsRpm).toBeUndefined();
  });

  it("keeps storage decimal strings exact beyond Number precision", () => {
    const envelope = readyEnvelope();
    const storage = sectionOf(envelope, "storage");
    storage.bytesUsed = "900719925474099312345678901234567890";
    storage.bytesLimit = "900719925474099312345678901234567891";

    const parsed = parseAccountLimitsEnvelope(envelope);

    expect(parsed.storage.bytesUsed).toBe(
      "900719925474099312345678901234567890",
    );
    expect(parsed.storage.bytesLimit).toBe(
      "900719925474099312345678901234567891",
    );
  });

  it.each(malformedCases)(
    "%s with one generic client-safe error",
    (_name, mutate) => {
      const envelope = readyEnvelope();
      mutate(envelope);

      expect(() => parseAccountLimitsEnvelope(envelope)).toThrowError(
        new Error(INVALID_RESPONSE_MESSAGE),
      );
    },
  );
});

describe("fresh billing organization gate", () => {
  it("marks a cached organization as fetching until current membership resolves", async () => {
    authenticatedAs("user-one");
    let resolveMembership: (value: Record<string, unknown>) => void = () => {};
    const currentMembership = new Promise<Record<string, unknown>>(
      (resolve) => {
        resolveMembership = resolve;
      },
    );
    apiMock.mockReturnValueOnce(currentMembership);

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    client.setQueryData(["billing-user", "auth", "user-one"], {
      organization_id: ORG_ONE,
      wallet_address: null,
      organization: { credit_balance: "10" },
    });

    const { result } = renderHook(
      () => useBillingUser({ requireFreshOrganization: true }),
      { wrapper: queryWrapper(client) },
    );

    expect(result.current.user?.organization_id).toBe(ORG_ONE);
    expect(result.current.isFetching).toBe(true);
    expect(result.current.isFetchedAfterMount).toBe(false);
    expect(apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMembership({
        success: true,
        data: {
          organization_id: ORG_TWO,
          wallet_address: null,
          organization: { credit_balance: "20" },
        },
      });
      await currentMembership;
    });

    await waitFor(() =>
      expect(result.current.user?.organization_id).toBe(ORG_TWO),
    );
    expect(result.current.isFetching).toBe(false);
    expect(result.current.isFetchedAfterMount).toBe(true);
  });

  it("aborts an obsolete membership read and starts a new read after remount", async () => {
    authenticatedAs("user-one");
    let resolveOldMembership: (value: Record<string, unknown>) => void =
      () => {};
    const oldMembership = new Promise<Record<string, unknown>>((resolve) => {
      resolveOldMembership = resolve;
    });
    apiMock.mockReturnValueOnce(oldMembership).mockResolvedValueOnce({
      success: true,
      data: {
        organization_id: ORG_TWO,
        wallet_address: null,
        organization: { credit_balance: "20" },
      },
    });

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    client.setQueryData(["billing-user", "auth", "user-one"], {
      organization_id: ORG_ONE,
      wallet_address: null,
      organization: { credit_balance: "10" },
    });

    const first = renderHook(
      () => useBillingUser({ requireFreshOrganization: true }),
      { wrapper: queryWrapper(client) },
    );
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const firstSignal = record(apiMock.mock.calls[0]?.[1]).signal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);

    first.unmount();
    expect((firstSignal as AbortSignal).aborted).toBe(true);

    const second = renderHook(
      () => useBillingUser({ requireFreshOrganization: true }),
      { wrapper: queryWrapper(client) },
    );
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(second.result.current.user?.organization_id).toBe(ORG_TWO),
    );

    await act(async () => {
      resolveOldMembership({
        success: true,
        data: {
          organization_id: ORG_ONE,
          wallet_address: null,
          organization: { credit_balance: "10" },
        },
      });
      await oldMembership;
      await Promise.resolve();
    });

    expect(second.result.current.user?.organization_id).toBe(ORG_TWO);
    expect(second.result.current.isFetchedAfterMount).toBe(true);
  });
});

describe("useAccountLimitsSnapshot", () => {
  it.each(
    [
      {
        label: "unresolved auth",
        session: { ready: false, authenticated: true, userId: "user-one" },
      },
      {
        label: "signed out",
        session: { ready: true, authenticated: false, userId: null },
      },
      {
        label: "authenticated identity missing",
        session: { ready: true, authenticated: true, userId: null },
        organizationId: ORG_ONE,
      },
      {
        label: "authenticated organization missing",
        session: { ready: true, authenticated: true, userId: "user-one" },
        organizationId: null,
      },
    ].map((entry) => ({ organizationId: ORG_ONE, ...entry })),
  )("does not fetch for $label", ({ session, organizationId }) => {
    sessionState.current = {
      ready: session.ready,
      authenticated: session.authenticated,
      user:
        session.userId === null
          ? null
          : { id: session.userId, email: "user@example.test" },
    };
    const client = createQueryClient();

    const { result } = renderHook(
      () => useAccountLimitsSnapshot(organizationId),
      { wrapper: queryWrapper(client) },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("makes one exact organization-free GET and ignores focus", async () => {
    authenticatedAs("user-one");
    apiMock.mockResolvedValue(readyEnvelope());
    const client = createQueryClient();

    const { result } = renderHook(() => useAccountLimitsSnapshot(ORG_ONE), {
      wrapper: queryWrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/billing/limits",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes a cached snapshot on remount while preserving it as visible stale data", async () => {
    authenticatedAs("user-one");
    const firstEnvelope = readyEnvelope();
    sectionOf(firstEnvelope, "apps").used = 1;
    const refreshedEnvelope = readyEnvelope();
    sectionOf(refreshedEnvelope, "apps").used = 2;
    let resolveRefresh: (value: Record<string, unknown>) => void = () => {};
    const pendingRefresh = new Promise<Record<string, unknown>>((resolve) => {
      resolveRefresh = resolve;
    });
    apiMock
      .mockResolvedValueOnce(firstEnvelope)
      .mockReturnValueOnce(pendingRefresh);

    const client = createQueryClient();
    const first = renderHook(() => useAccountLimitsSnapshot(ORG_ONE), {
      wrapper: queryWrapper(client),
    });
    await waitFor(() => expect(first.result.current.data?.apps.used).toBe(1));
    first.unmount();

    const second = renderHook(() => useAccountLimitsSnapshot(ORG_ONE), {
      wrapper: queryWrapper(client),
    });
    expect(second.result.current.data?.apps.used).toBe(1);
    await waitFor(() => expect(second.result.current.isFetching).toBe(true));
    expect(apiMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRefresh(refreshedEnvelope);
      await pendingRefresh;
    });
    await waitFor(() => expect(second.result.current.data?.apps.used).toBe(2));
  });

  it("isolates cached data by user, refetches on identity change, and allows an explicit retry", async () => {
    authenticatedAs("user-one");
    const userOneEnvelope = readyEnvelope();
    sectionOf(userOneEnvelope, "apps").used = 1;
    const userTwoEnvelope = readyEnvelope();
    sectionOf(userTwoEnvelope, "apps").used = 2;

    let resolveUserTwo: (value: Record<string, unknown>) => void = () => {};
    const pendingUserTwo = new Promise<Record<string, unknown>>((resolve) => {
      resolveUserTwo = resolve;
    });
    apiMock
      .mockResolvedValueOnce(userOneEnvelope)
      .mockReturnValueOnce(pendingUserTwo)
      .mockResolvedValueOnce(userTwoEnvelope);

    const client = createQueryClient();
    const { result, rerender } = renderHook(
      () => useAccountLimitsSnapshot(ORG_ONE),
      { wrapper: queryWrapper(client) },
    );

    await waitFor(() => expect(result.current.data?.apps.used).toBe(1));
    authenticatedAs("user-two");
    rerender();

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeUndefined();
    await act(async () => {
      resolveUserTwo(userTwoEnvelope);
      await pendingUserTwo;
    });
    await waitFor(() => expect(result.current.data?.apps.used).toBe(2));

    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual([
      "billing",
      "account-limits",
      "user",
      "user-one",
      "organization",
      ORG_ONE,
    ]);
    expect(keys).toContainEqual([
      "billing",
      "account-limits",
      "user",
      "user-two",
      "organization",
      ORG_ONE,
    ]);

    await act(async () => {
      await result.current.refetch();
    });
    expect(apiMock).toHaveBeenCalledTimes(3);
  });

  it("does not carry cached limits across organizations for the same user", async () => {
    authenticatedAs("user-one");
    const firstEnvelope = readyEnvelope();
    sectionOf(firstEnvelope, "apps").used = 1;
    const secondEnvelope = readyEnvelope();
    sectionOf(secondEnvelope, "apps").used = 9;
    apiMock
      .mockResolvedValueOnce(firstEnvelope)
      .mockResolvedValueOnce(secondEnvelope);

    let organizationId = ORG_ONE;
    const client = createQueryClient();
    const { result, rerender } = renderHook(
      () => useAccountLimitsSnapshot(organizationId),
      { wrapper: queryWrapper(client) },
    );

    await waitFor(() => expect(result.current.data?.apps.used).toBe(1));
    organizationId = ORG_TWO;
    rerender();

    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.apps.used).toBe(9));
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(
      client.getQueryCache().find({
        queryKey: [
          "billing",
          "account-limits",
          "user",
          "user-one",
          "organization",
          ORG_ONE,
        ],
      })?.state.data,
    ).toMatchObject({ apps: { used: 1 } });
  });
});
