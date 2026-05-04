import { act, render, screen } from "@testing-library/react";
import { type ReactNode, useEffect, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { apiFetch } from "../../../lib/api-client";

// CliLoginContent's effect deps are [authenticated, ready, sessionId]. The
// useSessionAuth mock subscribes consumers to a module-level emitter so we
// can flicker `authenticated` mid-flight. apiFetch returns a deferred Promise
// resolved by the test AFTER the flicker.
// vi.mock factories are hoisted; anything they close over must come from
// vi.hoisted.

const harness = vi.hoisted(() => {
  type AuthState = {
    authenticated: boolean;
    ready: boolean;
    user: { id: string; email: string } | null;
  };

  const initialAuth: AuthState = {
    authenticated: true,
    ready: true,
    user: { id: "user-1", email: "user@example.com" },
  };
  const authStore: { value: AuthState } = { value: initialAuth };
  const authSubscribers = new Set<() => void>();
  const setAuth = (next: AuthState) => {
    authStore.value = next;
    for (const cb of authSubscribers) cb();
  };
  const resetAuth = () => {
    authStore.value = {
      authenticated: true,
      ready: true,
      user: { id: "user-1", email: "user@example.com" },
    };
  };

  type Deferred = {
    promise: Promise<Response>;
    resolve: (value: Response) => void;
  };
  const defer = (): Deferred => {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  const fetchState: { pending: Deferred | null } = { pending: null };

  return {
    authStore,
    authSubscribers,
    setAuth,
    resetAuth,
    defer,
    fetchState,
  };
});

const apiFetchMock = vi.hoisted(() =>
  vi.fn<typeof apiFetch>(async () => {
    const d = harness.defer();
    harness.fetchState.pending = d;
    return d.promise;
  }),
);

const MockApiError = vi.hoisted(
  () =>
    class MockApiError extends Error {
      constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
      ) {
        super(message);
        this.name = "ApiError";
      }
    },
);

vi.mock("@/lib/hooks/use-session-auth", () => ({
  useSessionAuth: () => {
    const [snapshot, setSnapshot] = useState(harness.authStore.value);
    useEffect(() => {
      const cb = () => setSnapshot(harness.authStore.value);
      harness.authSubscribers.add(cb);
      return () => {
        harness.authSubscribers.delete(cb);
      };
    }, []);
    return {
      ...snapshot,
      authSource: snapshot.authenticated ? "steward" : "none",
      stewardAuthenticated: snapshot.authenticated,
      stewardUser: snapshot.user,
    };
  },
}));

vi.mock("@/lib/providers/StewardProvider", () => ({
  clearStaleStewardSession: vi.fn(),
  LocalStewardAuthContext: {
    Provider: ({ children }: { children: ReactNode }) => children,
  },
}));

vi.mock("../../../lib/api-client", () => ({
  apiFetch: apiFetchMock,
  ApiError: MockApiError,
}));

// Imported after vi.mock() calls so the mocks are in place.
import CliLoginPage from "./page";

beforeEach(() => {
  harness.resetAuth();
  harness.fetchState.pending = null;
  apiFetchMock.mockClear();
});

afterEach(() => {
  harness.authSubscribers.clear();
});

describe("CliLoginContent — race condition on auth flicker", () => {
  it("renders success once the API resolves, even if auth flickered during the in-flight POST", async () => {
    render(
      <MemoryRouter
        initialEntries={["/auth/cli-login?session=test-session-id"]}
      >
        <CliLoginPage />
      </MemoryRouter>,
    );

    // Effect should fire and start the POST.
    await act(async () => {
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/auth/cli-session/test-session-id/complete",
      expect.objectContaining({ method: "POST" }),
    );
    expect(harness.fetchState.pending).not.toBeNull();

    // UI is currently in "completing" state. getByText throws if absent.
    expect(screen.getByText("Generating API Key")).not.toBeNull();

    // FLICKER: authenticated → false. Effect cleanup runs (active=false on
    // origin/develop). completionFiredRef stays true so the abort guard
    // skips abort.abort().
    act(() => {
      harness.setAuth({
        authenticated: false,
        ready: true,
        user: { id: "user-1", email: "user@example.com" },
      });
    });

    // FLICKER BACK: authenticated → true. Effect re-runs but
    // completionFiredRef.current === true so it returns early. Original
    // in-flight fetch is unaffected.
    act(() => {
      harness.setAuth({
        authenticated: true,
        ready: true,
        user: { id: "user-1", email: "user@example.com" },
      });
    });

    const pending = harness.fetchState.pending;
    if (!pending) throw new Error("expected pending fetch");
    await act(async () => {
      pending.resolve(
        new Response(JSON.stringify({ keyPrefix: "test_prefix_xyz" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Without the fix, `if (active)` skips setCompletion → UI stuck on
    // "Generating API Key". With the fix, success branch fires and the
    // returned keyPrefix is rendered.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    // getByText throws helpfully if the success UI didn't render.
    expect(screen.getByText("Authentication Complete!")).not.toBeNull();
    expect(screen.getByText("test_prefix_xyz")).not.toBeNull();
    // And the "completing" UI must be gone — proves the success setState ran.
    expect(screen.queryByText("Generating API Key")).toBeNull();
  });
});
