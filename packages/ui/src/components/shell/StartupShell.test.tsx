// @vitest-environment jsdom
//
// StartupShell's view gating (loading vs failure vs pairing vs bootstrap),
// stable loading lockup, and first-paint telemetry mark. Child surfaces are
// stubbed so only the shell's own gating runs; the telemetry module is real.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetStartupTraceForTests,
  hasStartupMark,
} from "../../state/startup-telemetry";
import { StartupShell } from "./StartupShell";
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

beforeEach(() => {
  __resetStartupTraceForTests();
});

afterEach(() => {
  cleanup();
});

describe("StartupShell — stable loading splash", () => {
  it("renders immediately with a static lockup and shimmer-only status", () => {
    render(<StartupShell view={loadingView} onRetry={vi.fn()} />);

    const splash = queryLoading();
    expect(splash).not.toBeNull();
    // Visual contract preserved: phase + role attributes still present.
    expect(splash?.getAttribute("data-startup-phase")).toBe("starting-backend");
    expect(splash?.getAttribute("role")).toBe("status");
    expect(splash?.style.fontFamily).toBe("Arial, system-ui, sans-serif");
    const lockup = screen.getByTestId("startup-brand-lockup");
    expect(lockup.className).not.toMatch(/(?:animate-|transition)/);
    const brandName = screen.getByText("elizaOS");
    expect(brandName.className).not.toMatch(/(?:shimmer|animate-|transition)/);
    const status = screen.getByText("Starting");
    expect(status.classList.contains("shimmer")).toBe(true);
    expect(status.classList.contains("text-base")).toBe(true);
    expect(status.classList.contains("font-medium")).toBe(true);
    expect(status.classList.contains("text-white/60")).toBe(true);
    expect(status.className).toContain("[--shimmer-color:rgba(255,255,255,1)]");
    expect(status.className).toContain("[--shimmer-duration:1.8s]");
    expect(status.classList.contains("motion-reduce:shimmer-none")).toBe(true);
    expect(status.classList.contains("motion-reduce:animate-none")).toBe(true);
    expect(status.classList.contains("opacity-80")).toBe(false);
    expect(status.classList.contains("animate-pulse")).toBe(false);
    // First-paint telemetry fires with the first visible React lockup.
    expect(hasStartupMark(FIRST_PAINT_MARK)).toBe(true);
  });

  it("hands an already-visible loading lockup directly to the ready app", () => {
    const { rerender } = render(
      <StartupShell view={loadingView} onRetry={vi.fn()} />,
    );

    expect(queryLoading()).not.toBeNull();
    rerender(<StartupShell view={{ kind: "none" }} onRetry={vi.fn()} />);

    expect(queryLoading()).toBeNull();
    expect(hasStartupMark(FIRST_PAINT_MARK)).toBe(true);
  });

  it("does not introduce a blank interval when loading resumes", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <StartupShell view={loadingView} onRetry={onRetry} />,
    );

    rerender(<StartupShell view={{ kind: "none" }} onRetry={onRetry} />);
    expect(queryLoading()).toBeNull();

    rerender(<StartupShell view={loadingView} onRetry={onRetry} />);
    expect(queryLoading()).not.toBeNull();
  });
});

describe("StartupShell — non-loading views", () => {
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
