/** Verifies StartupFailureView through the package's configured test harness. */
// @vitest-environment jsdom
//
// StartupFailureView recovery affordances per failure reason (e.g. an
// unreachable saved backend offers a first-run reset). Real component in jsdom;
// branding, bug-report, platform reload, and translation are mocked.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupFailureView } from "./StartupFailureView";

const mocks = vi.hoisted(() => ({
  startFreshFirstRunReload: vi.fn(),
  waitForCloudAgentRunning: vi.fn(),
}));

vi.mock("../../api", () => ({ client: {} }));
vi.mock("../../api/client-cloud", () => ({
  waitForCloudAgentRunning: mocks.waitForCloudAgentRunning,
}));

vi.mock("../../config/branding", () => ({
  useBranding: () => ({ appUrl: "https://elizaos.ai" }),
}));

vi.mock("../../hooks", () => ({
  useOptionalBugReport: () => null,
}));

vi.mock("../../platform", () => ({
  startFreshFirstRunReload: mocks.startFreshFirstRunReload,
}));

vi.mock("../../state", () => ({
  useAppSelector: <T,>(
    selector: (state: {
      t: (key: string, options?: { defaultValue?: string }) => string;
    }) => T,
  ): T =>
    selector({
      t: (_key, options) => options?.defaultValue ?? _key,
    }),
}));

afterEach(() => {
  cleanup();
  mocks.startFreshFirstRunReload.mockClear();
  mocks.waitForCloudAgentRunning.mockReset();
});

describe("StartupFailureView", () => {
  it("starts only on demand, prevents duplicate starts and retries the saved connection after readiness", async () => {
    let finish!: () => void;
    mocks.waitForCloudAgentRunning.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const retry = vi.fn();
    render(
      <StartupFailureView
        error={{
          reason: "agent-stopped",
          phase: "starting-backend",
          message: "Stopped",
          cloudAgentId: "agent-123",
          cloudManagementUrl: "https://cloud-staging.eliza.app/join",
        }}
        onRetry={retry}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Your agent is shut down" }),
    ).toBeTruthy();
    expect(mocks.waitForCloudAgentRunning).not.toHaveBeenCalled();
    const start = screen.getByRole("button", { name: "Start agent" });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(mocks.waitForCloudAgentRunning).toHaveBeenCalledTimes(1);
    expect(mocks.waitForCloudAgentRunning).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: "agent-123" }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Starting your agent",
    );
    expect(retry).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(mocks.startFreshFirstRunReload).not.toHaveBeenCalled();
  });

  it("keeps a rejected start actionable and exposes Cloud recovery without resetting the agent", async () => {
    mocks.waitForCloudAgentRunning.mockRejectedValue(
      new Error("Sign in to Eliza Cloud to start this agent."),
    );
    const retry = vi.fn();
    render(
      <StartupFailureView
        error={{
          reason: "agent-stopped",
          phase: "starting-backend",
          message: "Stopped",
          cloudAgentId: "agent-123",
          cloudManagementUrl: "https://cloud-staging.eliza.app/join",
        }}
        onRetry={retry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Sign in"),
    );
    expect(
      screen
        .getByRole("link", { name: "Open Eliza Cloud" })
        .getAttribute("href"),
    ).toBe("https://cloud-staging.eliza.app/join");
    expect(retry).not.toHaveBeenCalled();
    expect(screen.queryByTestId("startup-start-over")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(mocks.startFreshFirstRunReload).not.toHaveBeenCalled();
  });

  it("offers one first-run reset for unreachable saved backends", () => {
    render(
      <StartupFailureView
        error={{
          reason: "backend-unreachable",
          message:
            "Previously configured backend is unreachable. Check your connection or reset.",
          phase: "starting-backend",
        }}
        onRetry={vi.fn()}
      />,
    );

    const startOver = screen.getByTestId("startup-start-over");
    expect(startOver.textContent).toContain("Start over");
    expect(screen.queryByTestId("startup-use-cloud")).toBeNull();

    fireEvent.click(startOver);

    expect(mocks.startFreshFirstRunReload).toHaveBeenCalledTimes(1);
  });
});
