// @vitest-environment jsdom

/**
 * `StewardAuthProvider` route-gating: it lazy-loads the Steward auth runtime
 * only on routes that need auth (app-auth), fails loud on an invalid Steward
 * URL there, bypasses the runtime entirely on public routes, and shows a
 * loading state instead of auth-consuming children during the lazy-load (#10680).
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveBrowserStewardApiUrl = vi.fn(() => "placeholder-steward-url");

vi.mock("./steward-url", () => ({
  resolveBrowserStewardApiUrl: () => resolveBrowserStewardApiUrl(),
}));

// Controllable gate simulating the lazy `@stwd/*` runtime chunk. It is settled
// by default (existing tests observe the resolved runtime synchronously). A test
// can `hold()` it before rendering to keep the runtime suspended — exercising the
// Suspense fallback — then `release()` it to resolve.
const runtimeGate = vi.hoisted(() => {
  let settled = true;
  let pending: Promise<void> = Promise.resolve();
  let resolvePending: (() => void) | undefined;
  return {
    hold() {
      settled = false;
      pending = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
    },
    release() {
      if (settled) return;
      settled = true;
      resolvePending?.();
    },
    isSettled: () => settled,
    whenReady: () => pending,
  };
});

vi.mock("./StewardProviderRuntime", () => ({
  default: ({ children }: { children: ReactNode }) => {
    // Reaching this branch means the page needs auth context. While the runtime
    // is not ready, suspend so the Suspense fallback renders — mirroring the cold
    // lazy-chunk load in production.
    if (!runtimeGate.isSettled()) {
      throw runtimeGate.whenReady();
    }
    return <div data-testid="steward-runtime">{children}</div>;
  },
}));

import { StewardAuthProvider } from "./StewardProvider";

afterEach(() => {
  runtimeGate.release();
  cleanup();
  resolveBrowserStewardApiUrl.mockReturnValue("placeholder-steward-url");
});

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <StewardAuthProvider>
        <div data-testid="protected-child" />
      </StewardAuthProvider>
    </MemoryRouter>,
  );
}

describe("StewardAuthProvider", () => {
  it("renders a fail-loud auth configuration error on app-auth routes with an invalid Steward URL", () => {
    renderAt("/app-auth/authorize?app_id=app_123");

    expect(
      screen.getByRole("alert", { name: /sign-in temporarily unavailable/i }),
    ).toBeTruthy();
    expect(screen.queryByTestId("protected-child")).toBeNull();
  });

  it("keeps bypassing Steward runtime on routes that do not need auth", () => {
    renderAt("/docs");

    expect(screen.getByTestId("protected-child")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("loads the Steward runtime on app-auth routes with a valid Steward URL", async () => {
    resolveBrowserStewardApiUrl.mockReturnValue(
      "https://api.elizacloud.ai/steward",
    );

    renderAt("/app-auth/authorize?app_id=app_123");

    expect(await screen.findByTestId("steward-runtime")).toBeTruthy();
    expect(screen.getByTestId("protected-child")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // Regression: #10680. On a cold navigation to an auth route the lazy `@stwd`
  // runtime chunk is not yet loaded, so the Suspense fallback renders. It must
  // NOT render the page children — they consume Steward auth context
  // (`AuthorizeContent` calls `useAuth()`) and would throw "useAuth must be used
  // within a <StewardProvider>" before the provider is in the tree. The fallback
  // shows a loading state until the runtime resolves.
  it("shows a loading state instead of the auth-consuming children during the runtime lazy-load (#10680)", async () => {
    resolveBrowserStewardApiUrl.mockReturnValue(
      "https://api.elizacloud.ai/steward",
    );
    runtimeGate.hold();

    renderAt("/app-auth/authorize?app_id=app_123");

    // Fallback phase — the runtime (and its StewardProvider) is not in the tree.
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByTestId("protected-child")).toBeNull();
    expect(screen.queryByTestId("steward-runtime")).toBeNull();

    // Runtime resolves → children render inside the provider, loading clears.
    await act(async () => {
      runtimeGate.release();
      await runtimeGate.whenReady();
    });

    expect(await screen.findByTestId("steward-runtime")).toBeTruthy();
    expect(screen.getByTestId("protected-child")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
