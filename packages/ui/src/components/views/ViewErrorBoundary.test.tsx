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

beforeEach(() => {
  __resetViewLifecycleForTests();
  __resetViewRuntimeTelemetryForTests();
  installViewRuntimeTelemetryRing();
  // jsdom logs the caught error; silence the noise for a clean run.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Boom(): React.JSX.Element {
  throw new Error("kaboom");
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
    fireEvent.click(screen.getByTestId("view-error-retry"));
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
    expect(card.textContent).toContain("kaboom");
    expect(screen.getByTestId("view-error-retry")).toBeTruthy();
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
