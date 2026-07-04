// @vitest-environment jsdom
//
// StartupShell's view gating (loading vs failure vs pairing vs bootstrap) and
// its splash-delay + first-paint telemetry mark. Child surfaces are stubbed so
// only the shell's own gating runs; the telemetry module is real.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetStartupTraceForTests,
  hasStartupMark,
} from "../../state/startup-telemetry";
import { STARTUP_SPLASH_DELAY_MS, StartupShell } from "./StartupShell";
import type { StartupShellView } from "./startup-shell-types";

// The child surfaces pull in heavy trees (branding, platform, bootstrap flow);
// stub them so this suite only exercises StartupShell's own gating logic. The
// real telemetry module is used unmocked so we can assert the first-paint mark.
vi.mock("./StartupFailureView", () => ({
  StartupFailureView: () => <div data-testid="startup-failure" />,
}));
vi.mock("./PairingView", () => ({
  PairingView: () => <div data-testid="startup-pairing" />,
}));
vi.mock("../setup/BootstrapStep", () => ({
  BootstrapStep: () => <div data-testid="startup-bootstrap" />,
}));
vi.mock("../../config/boot-config-store", () => ({
  getBootConfig: () => ({}),
}));
vi.mock("../brand/eliza-mark", () => ({
  ElizaMark: () => <svg data-testid="eliza-mark" />,
}));

const FIRST_PAINT_MARK = "startup-shell:first-paint";

const loadingView: StartupShellView = {
  kind: "loading",
  phase: "starting-backend",
  status: "Starting…",
};

function queryLoading() {
  return screen.queryByTestId("startup-shell-loading");
}

// Timer callbacks call setState; flush them through act() so React commits the
// re-render before the assertion reads the DOM.
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetStartupTraceForTests();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("StartupShell — delayed loading splash", () => {
  it("does NOT render the splash before the delay threshold elapses", () => {
    render(<StartupShell view={loadingView} onRetry={vi.fn()} />);

    // Immediately after mount: nothing painted, no first-paint mark.
    expect(queryLoading()).toBeNull();
    expect(hasStartupMark(FIRST_PAINT_MARK)).toBe(false);

    // Advance to just before the threshold — still hidden.
    advance(STARTUP_SPLASH_DELAY_MS - 1);
    expect(queryLoading()).toBeNull();
    expect(hasStartupMark(FIRST_PAINT_MARK)).toBe(false);
  });

  it("renders the splash once the delay threshold is crossed", () => {
    render(<StartupShell view={loadingView} onRetry={vi.fn()} />);

    advance(STARTUP_SPLASH_DELAY_MS);

    const splash = queryLoading();
    expect(splash).not.toBeNull();
    // Visual contract preserved: phase + role attributes still present.
    expect(splash?.getAttribute("data-startup-phase")).toBe("starting-backend");
    expect(splash?.getAttribute("role")).toBe("status");
    // first-paint telemetry fires only when the splash actually paints.
    expect(hasStartupMark(FIRST_PAINT_MARK)).toBe(true);
  });

  it("NEVER renders the splash when the view becomes ready before the threshold (fast cached boot)", () => {
    const { rerender } = render(
      <StartupShell view={loadingView} onRetry={vi.fn()} />,
    );

    // App becomes ready well before the delay elapses.
    advance(STARTUP_SPLASH_DELAY_MS - 50);
    rerender(<StartupShell view={{ kind: "none" }} onRetry={vi.fn()} />);

    // Even after the original timer would have fired, no flash.
    advance(500);
    expect(queryLoading()).toBeNull();
    // The startup shell never painted, so no first-paint mark was recorded.
    expect(hasStartupMark(FIRST_PAINT_MARK)).toBe(false);
  });

  it("still shows the splash if a fast flicker returns to loading and then persists", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <StartupShell view={loadingView} onRetry={onRetry} />,
    );

    // Brief flip to ready then back to loading — the delay timer restarts.
    advance(STARTUP_SPLASH_DELAY_MS - 20);
    rerender(<StartupShell view={{ kind: "none" }} onRetry={onRetry} />);
    expect(queryLoading()).toBeNull();

    rerender(<StartupShell view={loadingView} onRetry={onRetry} />);
    // Only 100ms of continuous loading — still hidden (timer restarted).
    advance(100);
    expect(queryLoading()).toBeNull();

    // Cross the full threshold from the restart — now it paints.
    advance(STARTUP_SPLASH_DELAY_MS);
    expect(queryLoading()).not.toBeNull();
  });
});

describe("StartupShell — non-loading views render immediately (no delay)", () => {
  it("renders the error view immediately and marks first-paint", () => {
    render(
      <StartupShell
        view={{
          kind: "error",
          error: {
            reason: "backend-unreachable",
            message: "boom",
            phase: "starting-backend",
          },
        }}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByTestId("startup-failure")).toBeTruthy();
    expect(hasStartupMark(FIRST_PAINT_MARK)).toBe(true);
  });

  it("renders the pairing view immediately and marks first-paint", () => {
    render(<StartupShell view={{ kind: "pairing" }} onRetry={vi.fn()} />);

    expect(screen.getByTestId("startup-pairing")).toBeTruthy();
    expect(hasStartupMark(FIRST_PAINT_MARK)).toBe(true);
  });

  it("renders the bootstrap view immediately and marks first-paint", () => {
    render(
      <StartupShell
        view={{ kind: "bootstrap", onAdvance: vi.fn() }}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByTestId("startup-bootstrap")).toBeTruthy();
    expect(hasStartupMark(FIRST_PAINT_MARK)).toBe(true);
  });

  it("renders nothing and marks nothing for the ready (none) view", () => {
    const { container } = render(
      <StartupShell view={{ kind: "none" }} onRetry={vi.fn()} />,
    );

    expect(container.firstChild).toBeNull();
    expect(hasStartupMark(FIRST_PAINT_MARK)).toBe(false);
  });
});
