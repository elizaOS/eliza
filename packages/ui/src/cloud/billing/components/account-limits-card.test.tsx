/**
 * Exercises Account Limits rendering and retry behavior in jsdom with the
 * real visual-state component and a controlled React Query seam. The fixtures
 * preserve the server DTO, including partial unavailability and bigint-safe
 * storage strings.
 */

// @vitest-environment jsdom

import type { AccountLimitsSnapshot } from "@elizaos/cloud-shared/lib/services/account-limits-snapshot";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accountLimitsQuery = vi.hoisted(() => ({
  value: {
    data: undefined as AccountLimitsSnapshot | undefined,
    isPending: true,
    isFetched: false,
    isFetching: false,
    isPaused: false,
    isRefetchError: false,
    refetch: vi.fn<() => Promise<unknown>>(),
  },
}));

vi.mock("../data/account-limits", () => ({
  useAccountLimitsSnapshot: () => accountLimitsQuery.value,
}));

const translate = (key: string, vars?: Record<string, unknown>) => {
  const template =
    typeof vars?.defaultValue === "string" ? vars.defaultValue : key;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(vars?.[name] ?? ""),
  );
};

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudI18n: () => ({ lang: "en", t: translate }),
  useCloudT: () => translate,
}));

import {
  AccountLimitsCard,
  AccountLimitsCardView,
} from "./account-limits-card";

const READY_SNAPSHOT: AccountLimitsSnapshot = {
  observedAt: "2026-08-16T00:00:00.000Z",
  cloudCharacters: {
    source: "cloud-character-quota",
    state: "available",
    used: 3,
    limit: 5,
  },
  agentSandboxes: {
    source: "agent-sandbox-quota",
    used: 4,
    nonEagerCreate: { state: "available", limit: 5 },
    eagerManagedCreate: { state: "available", limit: 100 },
    state: "available",
    nonEagerCreateLimit: 5,
    eagerManagedCreateLimit: 100,
  },
  containers: {
    source: "container-quota",
    state: "at-limit",
    used: 2,
    limit: 2,
  },
  apps: {
    source: "apps-service",
    state: "available",
    used: 7,
    limit: 25,
  },
  storage: {
    source: "org-storage-quota",
    state: "over-limit",
    bytesUsed: "9007199254740993",
    bytesLimit: "9007199254740992",
  },
  inferenceRateLimits: {
    source: "org-rate-limits",
    state: "available",
    completionsRpm: 60,
    embeddingsRpm: 100,
  },
};

function cloneSnapshot(): AccountLimitsSnapshot {
  return structuredClone(READY_SNAPSHOT);
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  accountLimitsQuery.value = {
    data: undefined,
    isPending: true,
    isFetched: false,
    isFetching: false,
    isPaused: false,
    isRefetchError: false,
    refetch: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
  };
});

describe("AccountLimitsCardView", () => {
  it("renders a named stable loading state without fabricated values", () => {
    render(<AccountLimitsCardView state={{ kind: "loading" }} />);

    const status = screen.getByRole("status", {
      name: "Loading account limits",
    });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText(/0 of 0/i)).toBeNull();
    expect(screen.queryByText(/^unlimited$/i)).toBeNull();
  });

  it("renders every server authority, split sandbox paths, and configured rate caps", () => {
    render(
      <AccountLimitsCardView
        state={{
          kind: "ready",
          snapshot: cloneSnapshot(),
          refreshing: false,
          refreshFailed: false,
        }}
      />,
    );

    expect(screen.getByText("App-agent cloud characters")).toBeTruthy();
    expect(screen.getByText(/other character paths may differ/i)).toBeTruthy();
    expect(screen.getByText("3 of 5 used")).toBeTruthy();
    expect(screen.getByText("Agent sandboxes")).toBeTruthy();
    expect(screen.getByText("Standard sandbox create path")).toBeTruthy();
    expect(screen.getByText("Create cap: 5")).toBeTruthy();
    expect(screen.getByText("Managed sandbox create path")).toBeTruthy();
    expect(screen.getByText("Create cap: 100")).toBeTruthy();
    expect(screen.getByText(/same current count of 4 sandboxes/i)).toBeTruthy();
    expect(screen.getByText("Containers")).toBeTruthy();
    expect(screen.getByText("Applications")).toBeTruthy();
    expect(screen.getByText("60 completions / min")).toBeTruthy();
    expect(screen.getByText("100 embeddings / min")).toBeTruthy();
    expect(
      screen.getByText(
        /Current usage, remaining requests, enforcement status, and reset time are not reported/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/can create/i)).toBeNull();
    expect(screen.queryByText(/^unlimited$/i)).toBeNull();
  });

  it("renders the sandbox source supplied by the server", () => {
    const snapshot = cloneSnapshot();
    snapshot.agentSandboxes.source = "future-sandbox-authority";

    render(
      <AccountLimitsCardView
        state={{
          kind: "ready",
          snapshot,
          refreshing: false,
          refreshFailed: false,
        }}
      />,
    );

    expect(screen.getByText("Source: future-sandbox-authority")).toBeTruthy();
  });

  it("keeps exact storage bytes beyond Number precision", () => {
    render(
      <AccountLimitsCardView
        state={{
          kind: "ready",
          snapshot: cloneSnapshot(),
          refreshing: false,
          refreshFailed: false,
        }}
      />,
    );

    expect(
      screen.getByText(
        "Exact: 9,007,199,254,740,993 / 9,007,199,254,740,992 bytes",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Over limit")).toBeTruthy();
  });

  it("keeps healthy siblings visible when one source is unavailable", () => {
    const snapshot = cloneSnapshot();
    snapshot.cloudCharacters = {
      source: "cloud-character-quota",
      state: "unavailable",
      reason: "sensitive backend detail",
    };

    render(
      <AccountLimitsCardView
        state={{
          kind: "ready",
          snapshot,
          refreshing: false,
          refreshFailed: false,
        }}
      />,
    );

    expect(
      screen.getByText(/Some limit sources are unavailable/i),
    ).toBeTruthy();
    expect(screen.getByText("Limit unavailable")).toBeTruthy();
    expect(screen.getByText("7 of 25 used")).toBeTruthy();
    expect(screen.queryByText("sensitive backend detail")).toBeNull();
    expect(screen.queryByText(/0 of 5/)).toBeNull();
  });

  it("preserves known sandbox usage when only the managed cap is unavailable", () => {
    const snapshot = cloneSnapshot();
    snapshot.agentSandboxes.eagerManagedCreate = {
      state: "unavailable",
      reason: "source read failed",
    };
    snapshot.agentSandboxes.state = "unavailable";

    render(
      <AccountLimitsCardView
        state={{
          kind: "ready",
          snapshot,
          refreshing: false,
          refreshFailed: false,
        }}
      />,
    );

    expect(screen.getByText("Create cap: 5")).toBeTruthy();
    expect(screen.getByText(/same current count of 4 sandboxes/i)).toBeTruthy();
    expect(screen.getByText("Limit unavailable")).toBeTruthy();
    expect(screen.queryByText("source read failed")).toBeNull();
  });

  it("keeps cached values visible and labels them stale after refresh failure", () => {
    render(
      <AccountLimitsCardView
        state={{
          kind: "ready",
          snapshot: cloneSnapshot(),
          refreshing: false,
          refreshFailed: true,
        }}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Could not refresh account limits",
    );
    expect(screen.getByText("3 of 5 used")).toBeTruthy();
    const observed = screen.getAllByText(/Aug 16, 2026.*UTC/);
    expect(observed.length).toBeGreaterThan(0);
  });

  it("renders a terminal error with an accessible 44px retry action", () => {
    const onRetry = vi.fn();
    render(
      <AccountLimitsCardView
        state={{ kind: "error", retrying: false }}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Account limits unavailable",
    );
    const retry = screen.getByRole("button", { name: "Retry loading limits" });
    expect(retry.className).toContain("min-h-11");
    expect(retry.className).toContain("keyboard-focus-surface");
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("announces an in-place refresh without replacing the snapshot", () => {
    render(
      <AccountLimitsCardView
        state={{
          kind: "ready",
          snapshot: cloneSnapshot(),
          refreshing: true,
          refreshFailed: false,
        }}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Refreshing");
    expect(screen.getByText("3 of 5 used")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Refresh limits",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("announces a paused initial request without presenting an active retry", () => {
    render(<AccountLimitsCardView state={{ kind: "paused" }} />);

    expect(screen.getByRole("status").textContent).toContain(
      "Waiting for a connection",
    );
    const waiting = screen.getByRole("button", {
      name: "Waiting for connection",
    }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
    expect(waiting.getAttribute("aria-busy")).toBe("false");
  });

  it("keeps a snapshot visible and marks an offline refresh as paused", () => {
    render(
      <AccountLimitsCardView
        state={{
          kind: "ready",
          snapshot: cloneSnapshot(),
          refreshing: false,
          refreshPaused: true,
          refreshFailed: false,
        }}
      />,
    );

    expect(screen.getAllByText("Waiting for connection").length).toBe(2);
    expect(screen.getByText("3 of 5 used")).toBeTruthy();
    expect(screen.getByText(/Refresh paused until a connection/i)).toBeTruthy();
    const waiting = screen.getByRole("button", {
      name: "Waiting for connection",
    }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
  });
});

describe("AccountLimitsCard", () => {
  it("maps a never-fetched pending query to the loading state", () => {
    accountLimitsQuery.value = {
      data: undefined,
      isPending: true,
      isFetched: false,
      isFetching: true,
      isPaused: false,
      isRefetchError: false,
      refetch: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
    };

    render(<AccountLimitsCard organizationId="org-one" />);

    expect(
      screen.getByRole("status", { name: "Loading account limits" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the retry alert busy while a previously fetched query refetches", () => {
    accountLimitsQuery.value = {
      data: undefined,
      isPending: true,
      isFetched: true,
      isFetching: true,
      isPaused: false,
      isRefetchError: false,
      refetch: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
    };

    render(<AccountLimitsCard organizationId="org-one" />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Account limits unavailable",
    );
    const retry = screen.getByRole("button", {
      name: "Retry loading limits",
    }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(
      screen.queryByRole("status", { name: "Loading account limits" }),
    ).toBeNull();
  });

  it("maps a paused initial query to the waiting-for-connection state", () => {
    accountLimitsQuery.value = {
      data: undefined,
      isPending: true,
      isFetched: false,
      isFetching: false,
      isPaused: true,
      isRefetchError: false,
      refetch: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
    };

    render(<AccountLimitsCard organizationId="org-one" />);

    expect(screen.getByRole("status").textContent).toContain(
      "Waiting for a connection",
    );
  });

  it("maps a paused refresh to an explicit stale snapshot state", () => {
    accountLimitsQuery.value = {
      data: cloneSnapshot(),
      isPending: false,
      isFetched: true,
      isFetching: false,
      isPaused: true,
      isRefetchError: false,
      refetch: vi.fn<() => Promise<unknown>>().mockResolvedValue({}),
    };

    render(<AccountLimitsCard organizationId="org-one" />);

    expect(screen.getByText("3 of 5 used")).toBeTruthy();
    expect(screen.getByText(/Refresh paused until a connection/i)).toBeTruthy();
  });

  it("synchronously suppresses duplicate retries before React can commit busy state", async () => {
    let resolveRefetch: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolveRefetch = resolve;
    });
    const refetch = vi.fn<() => Promise<unknown>>().mockReturnValue(pending);
    accountLimitsQuery.value = {
      data: undefined,
      isPending: false,
      isFetched: true,
      isFetching: false,
      isPaused: false,
      isRefetchError: false,
      refetch,
    };

    render(<AccountLimitsCard organizationId="org-one" />);
    const retry = screen.getByRole("button", { name: "Retry loading limits" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(refetch).toHaveBeenCalledTimes(1);

    resolveRefetch?.({});
    await pending;
    await waitFor(() => {
      fireEvent.click(retry);
      expect(refetch).toHaveBeenCalledTimes(2);
    });
  });
});
