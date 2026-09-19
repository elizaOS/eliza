/** Verifies ViewErrorBoundary through the package's configured test harness. */
// @vitest-environment jsdom
//
// ViewErrorBoundary: crash containment + recovery + crash telemetry (#10202,
// criterion #4 — "the test suite can catch ... one crash").

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetViewLifecycleForTests,
  viewLifecycleController,
} from "../../state/view-lifecycle";
import {
  __resetViewRuntimeTelemetryForTests,
  installViewRuntimeTelemetryRing,
  readViewRuntimeTelemetry,
} from "../../view-runtime-telemetry";
import { ViewErrorBoundary } from "./ViewErrorBoundary";

/** Must match CHUNK_RELOAD_AT_KEY in utils/chunk-load-recovery.ts. */
const RELOAD_MARKER_KEY = "eliza:chunk-reload-attempted-at";
/** Must match RELOAD_COOLDOWN_MS in utils/chunk-load-recovery.ts. */
const COOLDOWN_MS = 5 * 60 * 1000;

// The two stale-deploy chunk-fetch message forms the boundary must self-heal:
// a hashed JS view chunk that 404s after a deploy, and Vite's CSS-preload
// failure for a stylesheet that moved with the same deploy.
const CHUNK_FAILURES = [
  [
    "JavaScript import",
    "Failed to fetch dynamically imported module: https://eliza.app/assets/NotesView-Bx1v9qQ3.js",
  ],
  ["Vite CSS preload", "Unable to preload CSS for /assets/notes-view-old.css"],
] as const;

let reloadSpy: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

beforeEach(() => {
  __resetViewLifecycleForTests();
  __resetViewRuntimeTelemetryForTests();
  installViewRuntimeTelemetryRing();
  // A stale reload marker from another suite would suppress the one-shot
  // reload; start every case with an empty cooldown budget.
  window.sessionStorage.clear();
  // The recovery path calls window.location.reload(); jsdom cannot navigate,
  // so stub reload with a spy the way CloudRouteErrorBoundary's suite does.
  reloadSpy = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload: reloadSpy },
  });
  // jsdom logs the caught error; silence the noise for a clean run.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

function Boom(): React.JSX.Element {
  throw new Error("kaboom");
}

function ChunkBoom({ message }: { message: string }): React.JSX.Element {
  throw new Error(message);
}

function Recoverable({ crash }: { crash: boolean }): React.JSX.Element {
  if (crash) throw new Error("kaboom");
  return <div data-testid="recovered">recovered ok</div>;
}

describe("ViewErrorBoundary", () => {
  it("contains a crash: shows the fallback while a sibling stays mounted", () => {
    render(
      <div>
        <ViewErrorBoundary viewId="crasher">
          <Boom />
        </ViewErrorBoundary>
        <div data-testid="sibling">sibling alive</div>
      </div>,
    );
    expect(screen.getByTestId("view-error-boundary-fallback")).toBeTruthy();
    // The unrelated sibling is untouched — crash did not destabilize the shell.
    expect(screen.getByTestId("sibling")).toBeTruthy();
  });

  it("marks the view crashed on the lifecycle controller", () => {
    render(
      <ViewErrorBoundary viewId="crasher">
        <Boom />
      </ViewErrorBoundary>,
    );
    expect(viewLifecycleController.getPhase("crasher")).toBe("crashed");
  });

  it("emits a crash telemetry sample", () => {
    render(
      <ViewErrorBoundary viewId="crasher">
        <Boom />
      </ViewErrorBoundary>,
    );
    const crashEvents = readViewRuntimeTelemetry().filter(
      (e) => e.reason === "crash" && e.viewId === "crasher",
    );
    expect(crashEvents.length).toBeGreaterThanOrEqual(1);
    expect(crashEvents[0].phase).toBe("crashed");
  });

  it("recovers when Retry is pressed and the child no longer throws", () => {
    function Harness(): React.JSX.Element {
      const [crash, setCrash] = useState(true);
      return (
        <ViewErrorBoundary viewId="crasher" onRecover={() => setCrash(false)}>
          <Recoverable crash={crash} />
        </ViewErrorBoundary>
      );
    }
    render(<Harness />);
    expect(screen.getByTestId("view-error-boundary-fallback")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(screen.getByTestId("recovered")).toBeTruthy();
    // The view recovered out of the crashed phase (markRecovering passes through
    // "recovering" and resolves to a resting phase — here "inactive" since this
    // isolated boundary is not the controller's active view).
    expect(viewLifecycleController.getPhase("crasher")).not.toBe("crashed");
  });

  it("renders a non-blank fallback card (message + retry), never an empty container", () => {
    const { container } = render(
      <ViewErrorBoundary viewId="crasher">
        <Boom />
      </ViewErrorBoundary>,
    );
    const card = screen.getByTestId("view-error-boundary-fallback");
    // The card is a real, non-empty DOM node — not a blank white screen.
    expect(card).toBeTruthy();
    expect(container.textContent).not.toBe("");
    expect(card.textContent).toContain("This view couldn’t open");
    expect(card.textContent).not.toContain("kaboom");
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("uses a caller-supplied richer fallback when provided", () => {
    render(
      <ViewErrorBoundary
        viewId="crasher"
        renderFallback={(error) => (
          <div data-testid="custom-fallback">custom: {error.message}</div>
        )}
      >
        <Boom />
      </ViewErrorBoundary>,
    );
    expect(screen.getByTestId("custom-fallback").textContent).toContain(
      "kaboom",
    );
  });
});

// Pins the mid-session-deploy chunk-reload self-heal (#15383/#30889) at the
// app-views boundary: a stale lazy-chunk fetch failure triggers exactly ONE
// cooldown-guarded reload and does NOT latch the view crashed, while a
// non-chunk crash and a cooldown-exhausted chunk failure both degrade to the
// crash card with zero reloads. Without this coverage, dropping the
// `isChunkLoadError(error) && tryChunkReloadRecovery()` guard in handleError
// passes CI while reintroducing the #15383 regression (every not-yet-visited
// view shows a permanent crash card after a deploy).
describe("ViewErrorBoundary — stale-deploy chunk reload self-heal", () => {
  it.each(CHUNK_FAILURES)(
    "reloads exactly once for a %s failure and does NOT mark the view crashed",
    (_kind, message) => {
      render(
        <ViewErrorBoundary viewId="chunk-view">
          <ChunkBoom message={message} />
        </ViewErrorBoundary>,
      );

      // Exactly one reload picks up the current build and heals every view.
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      // handleError returns BEFORE markCrashed/telemetry — the view is not
      // latched crashed, so the reloaded shell mounts it fresh. A view never
      // marked has no lifecycle record (getPhase → null), never "crashed".
      expect(viewLifecycleController.getPhase("chunk-view")).toBeNull();
      expect(viewLifecycleController.getPhase("chunk-view")).not.toBe(
        "crashed",
      );
      // No crash telemetry sample is emitted on the recovery path.
      expect(
        readViewRuntimeTelemetry().filter(
          (e) => e.reason === "crash" && e.viewId === "chunk-view",
        ),
      ).toHaveLength(0);
      // The one-shot budget is stamped with a fresh, in-window timestamp.
      const marker = Number(window.sessionStorage.getItem(RELOAD_MARKER_KEY));
      expect(marker).toBeGreaterThan(0);
      expect(Date.now() - marker).toBeLessThan(COOLDOWN_MS);
    },
  );

  it("does NOT reload a non-chunk crash: marks it crashed and shows the fallback", () => {
    render(
      <ViewErrorBoundary viewId="crasher">
        <Boom />
      </ViewErrorBoundary>,
    );

    expect(reloadSpy).not.toHaveBeenCalled();
    // A plain render crash never touches the chunk-reload cooldown marker.
    expect(window.sessionStorage.getItem(RELOAD_MARKER_KEY)).toBeNull();
    // The non-chunk path falls through to markCrashed + telemetry + fallback.
    expect(viewLifecycleController.getPhase("crasher")).toBe("crashed");
    expect(screen.getByTestId("view-error-boundary-fallback")).toBeTruthy();
  });

  it.each(CHUNK_FAILURES)(
    "degrades a %s failure to the crash card when the reload budget is spent",
    (_kind, message) => {
      // A recovery reload already happened moments ago inside the cooldown, so
      // tryChunkReloadRecovery() returns false and the guard falls through.
      window.sessionStorage.setItem(RELOAD_MARKER_KEY, String(Date.now()));

      render(
        <ViewErrorBoundary viewId="chunk-view">
          <ChunkBoom message={message} />
        </ViewErrorBoundary>,
      );

      // One-shot budget pinned: no second reload loop.
      expect(reloadSpy).not.toHaveBeenCalled();
      // With the budget spent the boundary owns the failure like any crash:
      // marks it crashed and renders the fallback instead of a blank shell.
      expect(viewLifecycleController.getPhase("chunk-view")).toBe("crashed");
      expect(screen.getByTestId("view-error-boundary-fallback")).toBeTruthy();
    },
  );
});
