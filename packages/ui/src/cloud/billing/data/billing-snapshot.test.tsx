/** Contract tests for the exact billing snapshot parser and tenant-safe hook. */

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

vi.mock("../../lib/api-client", () => ({ api: apiMock }));
vi.mock("../../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionState.current,
}));

import {
  BILLING_SNAPSHOT_V2_QUERY_KEY,
  parseBillingSnapshotV2Envelope,
  useBillingSnapshotV2,
} from "./billing-snapshot";

const STARTED_AT = "2026-08-21T10:20:30.000Z";
const COMPLETED_AT = "2026-08-21T10:20:30.100Z";
const INVALID_RESPONSE_MESSAGE = "Billing snapshot response is invalid.";

function available(value: unknown, source = "billing-test") {
  return {
    status: "available",
    source,
    observedAt: COMPLETED_AT,
    value,
  };
}

function exact(value: string, unit: "usd" | "usd_per_hour" | "usd_per_day") {
  return { value, unit, currency: "USD" };
}

interface ResourceAuthorityFixture {
  billingInterval: "hour" | "day";
  lastBilledAt: string | null;
  nextBillingAt: string | null;
  estimatedNextBillingAt: string | null;
}

function resource(
  resourceId: string,
  type: "container" | "agent_sandbox",
  authority: ResourceAuthorityFixture,
) {
  return {
    resourceType: type,
    resourceId,
    name: type === "container" ? "API container" : "Research sandbox",
    status: "running",
    billingStatus: "active",
    ...authority,
    ratePerHour: available(exact("0.123456", "usd_per_hour"), "rates"),
    estimatedRecurringComputeCostPerDay: available(
      exact("2.962944", "usd_per_day"),
      "rates",
    ),
  };
}

function readyEnvelope(): Record<string, unknown> {
  return {
    success: true,
    data: {
      observedAt: COMPLETED_AT,
      schemaVersion: 2,
      v2: {
        snapshotStartedAt: STARTED_AT,
        snapshotCompletedAt: COMPLETED_AT,
        balance: available({
          balance: exact("900719925474099312345678.123456", "usd"),
          revision: "900719925474099312345678",
        }),
        activeCompute: {
          resources: available([
            resource("container-1", "container", {
              billingInterval: "hour",
              lastBilledAt: null,
              nextBillingAt: "2026-08-22T09:10:11.000Z",
              estimatedNextBillingAt: null,
            }),
            resource("sandbox-1", "agent_sandbox", {
              billingInterval: "day",
              lastBilledAt: "2026-08-20T08:07:06.000Z",
              nextBillingAt: null,
              estimatedNextBillingAt: "2026-08-23T12:34:56.000Z",
            }),
          ]),
          estimatedRecurringComputeCostPerDay: available(
            exact("5.925888", "usd_per_day"),
            "rates",
          ),
        },
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

function v2Of(envelope: Record<string, unknown>): Record<string, unknown> {
  return record(record(envelope.data).v2);
}

function activeOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return record(v2Of(envelope).activeCompute);
}

function availableValue(observation: unknown): unknown {
  return record(observation).value;
}

function authenticatedAs(userId: string): void {
  sessionState.current = {
    ready: true,
    authenticated: true,
    user: { id: userId, email: `${userId}@example.test` },
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
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
  apiMock.mockReset();
  sessionState.current = {
    ready: false,
    authenticated: false,
    user: null,
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("parseBillingSnapshotV2Envelope", () => {
  it("preserves exact balance and compute decimals beyond Number precision", () => {
    const parsed = parseBillingSnapshotV2Envelope(readyEnvelope());

    expect(parsed.balance.status).toBe("available");
    if (parsed.balance.status !== "available") throw new Error("fixture");
    expect(parsed.balance.value.balance.value).toBe(
      "900719925474099312345678.123456",
    );
    expect(parsed.balance.value.revision).toBe("900719925474099312345678");
    expect(parsed.activeCompute.resources.status).toBe("available");
    if (parsed.activeCompute.resources.status !== "available") {
      throw new Error("fixture");
    }
    expect(parsed.activeCompute.resources.value[0]?.ratePerHour.status).toBe(
      "available",
    );
  });

  it("preserves counterfactual interval and cursor authority per resource", () => {
    const parsed = parseBillingSnapshotV2Envelope(readyEnvelope());
    if (parsed.activeCompute.resources.status !== "available") {
      throw new Error("fixture");
    }

    const [container, sandbox] = parsed.activeCompute.resources.value;
    expect(container).toMatchObject({
      resourceType: "container",
      resourceId: "container-1",
      billingInterval: "hour",
      lastBilledAt: null,
      nextBillingAt: "2026-08-22T09:10:11.000Z",
      estimatedNextBillingAt: null,
    });
    expect(sandbox).toMatchObject({
      resourceType: "agent_sandbox",
      resourceId: "sandbox-1",
      billingInterval: "day",
      lastBilledAt: "2026-08-20T08:07:06.000Z",
      nextBillingAt: null,
      estimatedNextBillingAt: "2026-08-23T12:34:56.000Z",
    });
  });

  it("keeps an authoritative empty list distinct from unavailable", () => {
    const envelope = readyEnvelope();
    record(activeOf(envelope).resources).value = [];

    const parsed = parseBillingSnapshotV2Envelope(envelope);

    expect(parsed.activeCompute.resources).toMatchObject({
      status: "available",
      value: [],
    });
  });

  it("preserves outer and per-resource unavailable observations", () => {
    const envelope = readyEnvelope();
    const resources = availableValue(activeOf(envelope).resources) as unknown[];
    record(resources[0]).ratePerHour = {
      status: "unavailable",
      source: "rates",
      observedAt: COMPLETED_AT,
      error: { code: "rate_read_failed", retryable: true },
    };
    activeOf(envelope).estimatedRecurringComputeCostPerDay = {
      status: "unavailable",
      source: "rates",
      observedAt: COMPLETED_AT,
      error: { code: "active_compute_rate_incomplete", retryable: false },
    };

    const parsed = parseBillingSnapshotV2Envelope(envelope);

    expect(
      parsed.activeCompute.estimatedRecurringComputeCostPerDay,
    ).toMatchObject({ status: "unavailable" });
    if (parsed.activeCompute.resources.status !== "available") {
      throw new Error("fixture");
    }
    expect(parsed.activeCompute.resources.value[0]?.ratePerHour).toMatchObject({
      status: "unavailable",
      error: { retryable: true },
    });
  });

  it("preserves unknown-policy and not-applicable without zero fallbacks", () => {
    const envelope = readyEnvelope();
    v2Of(envelope).balance = {
      status: "not_applicable",
      source: "ledger",
      observedAt: COMPLETED_AT,
      reason: "account has no ledger",
    };
    activeOf(envelope).resources = {
      status: "unknown_policy",
      source: "compute",
      observedAt: COMPLETED_AT,
      blockedBy: ["#23091"],
    };

    const parsed = parseBillingSnapshotV2Envelope(envelope);

    expect(parsed.balance.status).toBe("not_applicable");
    expect(parsed.activeCompute.resources).toMatchObject({
      status: "unknown_policy",
      blockedBy: ["#23091"],
    });
  });

  const malformedCases: Array<
    [string, (envelope: Record<string, unknown>) => void]
  > = [
    ["false success", (envelope) => (envelope.success = false)],
    [
      "wrong schema version",
      (envelope) => (record(envelope.data).schemaVersion = 1),
    ],
    [
      "non-canonical timestamp",
      (envelope) => (v2Of(envelope).snapshotCompletedAt = "2026-08-21"),
    ],
    [
      "inverted snapshot interval",
      (envelope) =>
        (v2Of(envelope).snapshotStartedAt = "2026-08-21T10:20:31.000Z"),
    ],
    [
      "wrong balance unit",
      (envelope) => {
        const balance = record(availableValue(v2Of(envelope).balance));
        record(balance.balance).unit = "usd_per_day";
      },
    ],
    [
      "wrong currency",
      (envelope) => {
        const balance = record(availableValue(v2Of(envelope).balance));
        record(balance.balance).currency = "EUR";
      },
    ],
    [
      "non-canonical decimal",
      (envelope) => {
        const balance = record(availableValue(v2Of(envelope).balance));
        record(balance.balance).value = "01.00";
      },
    ],
    [
      "negative decimal",
      (envelope) => {
        const resources = availableValue(
          activeOf(envelope).resources,
        ) as unknown[];
        record(record(resources[0]).ratePerHour).value = exact(
          "-1",
          "usd_per_hour",
        );
      },
    ],
    [
      "malformed observation provenance",
      (envelope) => {
        record(activeOf(envelope).resources).source = "";
      },
    ],
    [
      "duplicate resource identity",
      (envelope) => {
        const resources = availableValue(
          activeOf(envelope).resources,
        ) as unknown[];
        record(resources[1]).resourceType = "container";
        record(resources[1]).resourceId = "container-1";
      },
    ],
    [
      "invalid billing interval",
      (envelope) => {
        const resources = availableValue(
          activeOf(envelope).resources,
        ) as unknown[];
        record(resources[0]).billingInterval = "week";
      },
    ],
    [
      "non-canonical billing cursor",
      (envelope) => {
        const resources = availableValue(
          activeOf(envelope).resources,
        ) as unknown[];
        record(resources[0]).nextBillingAt = "2026-08-22";
      },
    ],
  ];

  it.each(malformedCases)(
    "rejects %s with a client-safe error",
    (_name, mutate) => {
      const envelope = readyEnvelope();
      mutate(envelope);

      expect(() => parseBillingSnapshotV2Envelope(envelope)).toThrowError(
        new Error(INVALID_RESPONSE_MESSAGE),
      );
    },
  );
});

describe("useBillingSnapshotV2", () => {
  it.each([
    {
      label: "unresolved session",
      state: { ready: false, authenticated: true, userId: "user-one" },
      organizationId: "org-one",
    },
    {
      label: "signed out",
      state: { ready: true, authenticated: false, userId: null },
      organizationId: "org-one",
    },
    {
      label: "missing user",
      state: { ready: true, authenticated: true, userId: null },
      organizationId: "org-one",
    },
    {
      label: "missing organization",
      state: { ready: true, authenticated: true, userId: "user-one" },
      organizationId: null,
    },
  ])("does not fetch for $label", ({ state, organizationId }) => {
    sessionState.current = {
      ready: state.ready,
      authenticated: state.authenticated,
      user: state.userId
        ? { id: state.userId, email: "user@example.test" }
        : null,
    };

    const { result } = renderHook(() => useBillingSnapshotV2(organizationId), {
      wrapper: queryWrapper(createQueryClient()),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("makes one organization-free GET with an abort signal", async () => {
    authenticatedAs("user-one");
    apiMock.mockResolvedValue(readyEnvelope());

    const { result } = renderHook(() => useBillingSnapshotV2("org-one"), {
      wrapper: queryWrapper(createQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith(
      "/api/v1/billing/limits",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(JSON.stringify(apiMock.mock.calls)).not.toContain("org-one");
  });

  it("isolates cached snapshots across both user and organization", async () => {
    authenticatedAs("user-one");
    apiMock.mockResolvedValue(readyEnvelope());
    const client = createQueryClient();
    let organizationId = "org-one";

    const { result, rerender } = renderHook(
      () => useBillingSnapshotV2(organizationId),
      { wrapper: queryWrapper(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    organizationId = "org-two";
    rerender();
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));

    authenticatedAs("user-two");
    rerender();
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3));

    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual([
      ...BILLING_SNAPSHOT_V2_QUERY_KEY,
      "user",
      "user-one",
      "organization",
      "org-one",
    ]);
    expect(keys).toContainEqual([
      ...BILLING_SNAPSHOT_V2_QUERY_KEY,
      "user",
      "user-two",
      "organization",
      "org-two",
    ]);
  });

  it("revalidates cached data on remount and keeps it visible on refresh failure", async () => {
    authenticatedAs("user-one");
    apiMock
      .mockResolvedValueOnce(readyEnvelope())
      .mockRejectedValueOnce(new Error("backend detail must stay hidden"));
    const client = createQueryClient();

    const first = renderHook(() => useBillingSnapshotV2("org-one"), {
      wrapper: queryWrapper(client),
    });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => useBillingSnapshotV2("org-one"), {
      wrapper: queryWrapper(client),
    });
    expect(second.result.current.data).toBeDefined();
    await waitFor(() =>
      expect(second.result.current.isRefetchError).toBe(true),
    );
    expect(second.result.current.data).toBeDefined();
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("revalidates a healthy snapshot while the billing view stays mounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    authenticatedAs("user-one");
    apiMock.mockResolvedValue(readyEnvelope());
    const client = createQueryClient();

    const result = renderHook(() => useBillingSnapshotV2("org-one"), {
      wrapper: queryWrapper(client),
    });
    await waitFor(() => expect(result.result.current.isSuccess).toBe(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("aborts an obsolete request on unmount and permits explicit retry", async () => {
    authenticatedAs("user-one");
    let resolveFirst: (value: Record<string, unknown>) => void = () => {};
    const firstRequest = new Promise<Record<string, unknown>>((resolve) => {
      resolveFirst = resolve;
    });
    apiMock
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValueOnce(readyEnvelope());
    const client = createQueryClient();

    const first = renderHook(() => useBillingSnapshotV2("org-one"), {
      wrapper: queryWrapper(client),
    });
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const signal = record(apiMock.mock.calls[0]?.[1]).signal as AbortSignal;
    first.unmount();
    expect(signal.aborted).toBe(true);

    const second = renderHook(() => useBillingSnapshotV2("org-one"), {
      wrapper: queryWrapper(client),
    });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    await act(async () => {
      await second.result.current.refetch();
    });
    expect(apiMock).toHaveBeenCalledTimes(3);

    resolveFirst(readyEnvelope());
    await firstRequest;
  });
});
