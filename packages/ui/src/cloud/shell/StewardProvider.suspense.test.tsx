// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { useAuth } from "@stwd/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regression for #10680: the app-auth OAuth authorize flow crashed with
 * "useAuth must be used within a <StewardProvider>" on a cold navigation to
 * `/app-auth/authorize`.
 *
 * Root cause: `StewardAuthProvider` lazy-loads the heavy `@stwd/*` runtime and
 * used `<Suspense fallback={children}>`. While the runtime chunk loads, the
 * fallback rendered the children in a PROVIDER-LESS tree — and the authorize
 * consent (`authorize-content.tsx`) calls `useAuth()` from `@stwd/react`, which
 * throws when no `<StewardProvider>` ancestor is present.
 *
 * The sibling `StewardProvider.test.tsx` covers the config-error / bypass /
 * runtime-loads paths with a plain child that never calls `useAuth`, so it can
 * NOT catch this crash. This file drives the real lazy-load Suspense race with
 * FAITHFUL doubles: the mocked `@stwd/react` `useAuth` throws without a provider
 * (exactly like the real one), and the lazy `StewardProviderRuntime` is still
 * loaded via `import()` so the Suspense fallback genuinely activates on first
 * render — the exact window the bug lived in. Only the heavy `@stwd/sdk`
 * transitive stack is elided.
 *
 * `runtimeGate` lets a test hold the lazy chunk pending so the transient
 * fallback is observable deterministically (React flushes the resolving
 * microtask inside `act()` otherwise). It is released in `afterEach`, so once
 * the first test opens it the runtime module is resolved + cached and every
 * later render gets the provider synchronously.
 */
const runtimeGate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, open: () => release() };
});

vi.mock("@stwd/react", async () => {
  const React = await import("react");
  const StewardPresentContext = React.createContext(false);
  return {
    __esModule: true,
    StewardProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        StewardPresentContext.Provider,
        { value: true },
        children,
      ),
    useAuth: () => {
      if (!React.useContext(StewardPresentContext)) {
        throw new Error(
          "useAuth must be used within a <StewardProvider> with an `auth` prop.",
        );
      }
      return {
        isAuthenticated: false,
        isLoading: false,
        getToken: () => null,
        signOut: () => {},
        providers: null,
        isProvidersLoading: false,
        user: null,
        session: null,
      };
    },
    StewardLogin: () => null,
  };
});

vi.mock("./StewardProviderRuntime", async () => {
  await runtimeGate.promise;
  const React = await import("react");
  // Resolves to the mocked @stwd/react above, so the runtime provider shares the
  // same "provider present" context the useAuth() child reads.
  const { StewardProvider } = await import("@stwd/react");
  return {
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) =>
      React.createElement(StewardProvider, null, children),
  };
});

import { StewardAuthProvider } from "./StewardProvider";

function AuthConsumer() {
  const auth = useAuth();
  return (
    <div data-testid="auth-consumer">authed:{String(auth.isAuthenticated)}</div>
  );
}

afterEach(() => {
  // Release the lazy chunk so subsequent tests render the runtime synchronously
  // (idempotent — resolving an already-settled promise is a no-op).
  runtimeGate.open();
  cleanup();
  localStorage.clear();
});

describe("StewardAuthProvider lazy-runtime Suspense fallback (#10680)", () => {
  // Ordered first: this is the only test that observes the pending-chunk window,
  // so it must run before afterEach releases the gate for the others.
  it("shows a busy loading placeholder — not provider-less children — while the runtime chunk is loading", async () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/app-auth/authorize"]}>
        <StewardAuthProvider>
          <AuthConsumer />
        </StewardAuthProvider>
      </MemoryRouter>,
    );

    // Chunk still pending: the auth-requiring child must NOT be in the tree; a
    // busy placeholder fills the slot instead. (Pre-fix this threw instead.)
    expect(screen.queryByTestId("auth-consumer")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    runtimeGate.open();
    await waitFor(() =>
      expect(screen.getByTestId("auth-consumer")).toBeTruthy(),
    );
  });

  it("does not crash a useAuth() child while mounting the Steward runtime", async () => {
    expect(() =>
      render(
        <MemoryRouter initialEntries={["/app-auth/authorize"]}>
          <StewardAuthProvider>
            <AuthConsumer />
          </StewardAuthProvider>
        </MemoryRouter>,
      ),
    ).not.toThrow();

    await waitFor(() =>
      expect(screen.getByTestId("auth-consumer")).toBeTruthy(),
    );
  });

  it("still loads the runtime (and never crashes) when a stored token forces it on a non-auth route", async () => {
    // A minimally-valid, non-expired Steward JWT so readStoredToken() → runtime.
    const future = Math.floor(Date.now() / 1000) + 3600;
    const b64 = (v: unknown) =>
      btoa(JSON.stringify(v))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    localStorage.setItem(
      STEWARD_TOKEN_KEY,
      `${b64({ alg: "none" })}.${b64({ userId: "u1", exp: future })}.sig`,
    );

    expect(() =>
      render(
        <MemoryRouter initialEntries={["/gallery"]}>
          <StewardAuthProvider>
            <AuthConsumer />
          </StewardAuthProvider>
        </MemoryRouter>,
      ),
    ).not.toThrow();

    await waitFor(() =>
      expect(screen.getByTestId("auth-consumer")).toBeTruthy(),
    );
  });

  it("renders children directly (no runtime, no loading) on a non-auth route with no token", () => {
    render(
      <MemoryRouter initialEntries={["/gallery"]}>
        <StewardAuthProvider>
          <div data-testid="plain-child" />
        </StewardAuthProvider>
      </MemoryRouter>,
    );

    // Fast path preserved: children render synchronously.
    expect(screen.getByTestId("plain-child")).toBeTruthy();
  });
});
