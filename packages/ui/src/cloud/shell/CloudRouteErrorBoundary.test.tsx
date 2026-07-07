// @vitest-environment jsdom

/**
 * CloudRouteErrorBoundary: post-deploy stale-chunk self-heal for console
 * routes (#15383). Pins the recovery contract both ways — a chunk-load error
 * triggers exactly ONE cooldown-guarded reload (timestamped marker in
 * sessionStorage), a second chunk failure inside the cooldown does NOT reload
 * (manual Reload card instead), a lapsed cooldown re-arms one more attempt,
 * and a non-chunk render crash degrades to the Retry card with zero reloads
 * and the marker untouched. Also covers the steward-runtime lazy mount
 * (StewardAuthProvider) being wrapped by this boundary, so a stale `@stwd/*`
 * runtime chunk self-heals instead of escaping to the app-root boundary.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The steward-runtime coverage case needs a valid Steward URL (an invalid one
// short-circuits to the config-error card before the lazy chunk ever loads).
vi.mock("./steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.elizacloud.ai/steward",
}));

// Simulate the #15383 failure for the steward runtime: after a mid-session
// deploy the lazy `@stwd/*` chunk 404s and the dynamic import rejects with the
// browser's chunk-fetch error; React surfaces that rejection by throwing it
// while rendering the lazy component under the Suspense, so a default export
// that throws the same error models what the boundary sees. (A throwing mock
// FACTORY can't — vitest wraps factory errors in its own message, which would
// defeat isChunkLoadError.)
vi.mock("./StewardProviderRuntime", () => ({
  default: () => {
    throw new Error(
      "Failed to fetch dynamically imported module: https://elizacloud.ai/assets/StewardProviderRuntime-CvR8b1x2.js",
    );
  },
}));

import { CloudRouteErrorBoundary } from "./CloudRouteErrorBoundary";
import { StewardAuthProvider } from "./StewardProvider";

/** Must match CHUNK_RELOAD_AT_KEY in utils/chunk-load-recovery.ts. */
const RELOAD_MARKER_KEY = "eliza:chunk-reload-attempted-at";
const COOLDOWN_MS = 5 * 60 * 1000;

const CHUNK_ERROR_MESSAGE =
  "Failed to fetch dynamically imported module: https://elizacloud.ai/assets/BillingPage-Bx1v9qQ3.js";

function ChunkBoom(): React.JSX.Element {
  throw new Error(CHUNK_ERROR_MESSAGE);
}

function PlainBoom(): React.JSX.Element {
  throw new Error("kaboom");
}

let reloadSpy: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

beforeEach(() => {
  window.sessionStorage.clear();
  reloadSpy = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload: reloadSpy },
  });
  // jsdom logs the caught render error; silence the noise for a clean run.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.restoreAllMocks();
});

describe("CloudRouteErrorBoundary — chunk-load recovery", () => {
  it("reloads exactly once on a chunk-load error and stamps the cooldown marker", () => {
    render(
      <CloudRouteErrorBoundary routePath="dashboard/billing">
        <ChunkBoom />
      </CloudRouteErrorBoundary>,
    );

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    const marker = Number(window.sessionStorage.getItem(RELOAD_MARKER_KEY));
    // Timestamped (not a latched boolean) so a LATER deploy in the same
    // session can auto-heal again after the cooldown lapses.
    expect(marker).toBeGreaterThan(0);
    expect(Date.now() - marker).toBeLessThan(COOLDOWN_MS);
  });

  it("does NOT auto-reload again inside the cooldown: shows the manual Reload card", () => {
    // A recovery attempt already happened moments ago (marker = now).
    window.sessionStorage.setItem(RELOAD_MARKER_KEY, String(Date.now()));

    render(
      <CloudRouteErrorBoundary routePath="dashboard/billing">
        <ChunkBoom />
      </CloudRouteErrorBoundary>,
    );

    // No reload loop: the budget is spent, so the failure degrades to the
    // designed card with an explicit user-initiated Reload affordance.
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("cloud-route-error-fallback")).toBeTruthy();
    const reloadButton = screen.getByTestId("cloud-route-error-reload");
    expect(reloadButton.textContent).toContain("Reload");

    fireEvent.click(reloadButton);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("allows one more auto-reload after the cooldown lapses", () => {
    const staleAttempt = Date.now() - (COOLDOWN_MS + 60_000);
    window.sessionStorage.setItem(RELOAD_MARKER_KEY, String(staleAttempt));

    render(
      <CloudRouteErrorBoundary routePath="dashboard/billing">
        <ChunkBoom />
      </CloudRouteErrorBoundary>,
    );

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // The marker was re-stamped for the new attempt window.
    const marker = Number(window.sessionStorage.getItem(RELOAD_MARKER_KEY));
    expect(marker).toBeGreaterThan(staleAttempt);
  });

  it("shows the Retry card for a NON-chunk render error: zero reloads, marker untouched", () => {
    render(
      <CloudRouteErrorBoundary routePath="dashboard/billing">
        <PlainBoom />
      </CloudRouteErrorBoundary>,
    );

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(RELOAD_MARKER_KEY)).toBeNull();
    const card = screen.getByTestId("cloud-route-error-fallback");
    expect(card.textContent).toContain("kaboom");
    expect(screen.getByTestId("cloud-route-error-retry")).toBeTruthy();
    expect(screen.queryByTestId("cloud-route-error-reload")).toBeNull();
  });

  it("Retry remounts the subtree and recovers once the child no longer throws", () => {
    function Recoverable({ crash }: { crash: boolean }): React.JSX.Element {
      if (crash) throw new Error("kaboom");
      return <div data-testid="recovered">recovered ok</div>;
    }
    function Harness(): React.JSX.Element {
      const [crash, setCrash] = useState(true);
      return (
        <div>
          <button
            type="button"
            data-testid="fix-child"
            onClick={() => setCrash(false)}
          >
            fix
          </button>
          <CloudRouteErrorBoundary routePath="dashboard/billing">
            <Recoverable crash={crash} />
          </CloudRouteErrorBoundary>
        </div>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId("cloud-route-error-fallback")).toBeTruthy();

    fireEvent.click(screen.getByTestId("fix-child"));
    fireEvent.click(screen.getByTestId("cloud-route-error-retry"));

    expect(screen.getByTestId("recovered")).toBeTruthy();
    expect(screen.queryByTestId("cloud-route-error-fallback")).toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe("StewardAuthProvider — steward-runtime chunk failures self-heal (D2)", () => {
  function renderDashboard() {
    return render(
      <MemoryRouter initialEntries={["/dashboard/billing"]}>
        <StewardAuthProvider>
          <div data-testid="protected-child" />
        </StewardAuthProvider>
      </MemoryRouter>,
    );
  }

  it("catches a stale steward-runtime chunk and fires the one-shot reload recovery", async () => {
    renderDashboard();

    // The lazy import rejection must be caught by the boundary WRAPPING the
    // Suspense — not escape to (a nonexistent) app-root handler — and hand off
    // to the shared reload recovery.
    expect(
      await screen.findByTestId("cloud-route-error-fallback"),
    ).toBeTruthy();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(
      Number(window.sessionStorage.getItem(RELOAD_MARKER_KEY)),
    ).toBeGreaterThan(0);
  });

  it("degrades to the manual Reload card when the steward chunk fails inside the cooldown", async () => {
    window.sessionStorage.setItem(RELOAD_MARKER_KEY, String(Date.now()));

    renderDashboard();

    expect(await screen.findByTestId("cloud-route-error-reload")).toBeTruthy();
    expect(reloadSpy).not.toHaveBeenCalled();
    // The auth-consuming children never render without the provider.
    expect(screen.queryByTestId("protected-child")).toBeNull();
  });
});
