/** Verifies StartupFailureView through the package's configured test harness. */
// @vitest-environment jsdom
//
// StartupFailureView recovery affordances per failure reason (e.g. an
// unreachable saved backend retains its connection and offers Retry). Real component in jsdom;
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
  repointBaseUrl: vi.fn(),
  setToken: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  client: { repointBaseUrl: mocks.repointBaseUrl, setToken: mocks.setToken },
}));
vi.mock("../../api/client-cloud", () => ({
  waitForCloudAgentRunning: mocks.waitForCloudAgentRunning,
}));

vi.mock("../../config/branding-react.hooks", () => ({
  useBranding: () => ({ appUrl: "https://elizaos.ai" }),
}));

vi.mock("../../hooks/useBugReport.hooks", () => ({
  useOptionalBugReport: () => null,
}));

vi.mock("../../platform/first-run-reset", () => ({
  startFreshFirstRunReload: mocks.startFreshFirstRunReload,
}));

vi.mock("../../state/app-store", () => ({
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
  mocks.repointBaseUrl.mockClear();
  mocks.setToken.mockClear();
});

describe("StartupFailureView", () => {
  it.each(["backend-unreachable", "backend-timeout"] as const)(
    "opens existing connection settings during %s without clearing saved authority",
    (reason) => {
      localStorage.clear();
      const oldProfile = {
        id: "saved-mac",
        kind: "remote",
        label: "Saved Mac",
        apiBase: "http://10.0.0.241:31725",
        accessToken: "old-host-only-token",
        createdAt: "2026-10-01T00:00:00Z",
      };
      localStorage.setItem(
        "elizaos:agent-profiles",
        JSON.stringify({
          version: 1,
          activeProfileId: oldProfile.id,
          profiles: [oldProfile],
        }),
      );
      localStorage.setItem(
        "eliza:chat:activeConversationId",
        "original-conversation",
      );
      localStorage.setItem("pairing-history", "keep-original-pairing");
      const before = { ...localStorage };
      const retry = vi.fn();
      render(
        <StartupFailureView
          error={{
            reason,
            phase: "starting-backend",
            message: "Saved Mac is unavailable",
          }}
          onRetry={retry}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Connection settings" }),
      );
      expect(screen.getByTestId("runtime-saved-mac-active")).toBeTruthy();
      expect(screen.getByTestId("add-remote-url")).toBeTruthy();
      expect(
        (screen.getByTestId("add-remote-token") as HTMLInputElement).value,
      ).toBe("");
      expect({ ...localStorage }).toEqual(before);
      expect(mocks.repointBaseUrl).not.toHaveBeenCalled();
      expect(mocks.startFreshFirstRunReload).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", { name: "Connection settings" }),
      );
      expect(screen.queryByTestId("my-runtimes")).toBeNull();
      expect({ ...localStorage }).toEqual(before);
      fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
      expect(retry).toHaveBeenCalledOnce();
      localStorage.clear();
    },
  );

  it("connects a new trusted URL without forwarding the saved host token or wiping history", () => {
    localStorage.clear();
    const oldProfile = {
      id: "saved-mac",
      kind: "remote",
      label: "Saved Mac",
      apiBase: "http://10.0.0.241:31725",
      accessToken: "old-host-only-token",
      createdAt: "2026-10-01T00:00:00Z",
    };
    localStorage.setItem(
      "elizaos:agent-profiles",
      JSON.stringify({
        version: 1,
        activeProfileId: oldProfile.id,
        profiles: [oldProfile],
      }),
    );
    localStorage.setItem(
      "eliza:chat:activeConversationId",
      "original-conversation",
    );
    localStorage.setItem("pairing-history", "keep-original-pairing");
    render(
      <StartupFailureView
        error={{
          reason: "backend-unreachable",
          phase: "starting-backend",
          message: "Saved Mac is unavailable",
        }}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Connection settings" }),
    );
    fireEvent.change(screen.getByTestId("add-remote-label"), {
      target: { value: "Replacement Mac" },
    });
    fireEvent.change(screen.getByTestId("add-remote-url"), {
      target: { value: "http://10.0.0.242:31725" },
    });
    fireEvent.click(screen.getByTestId("add-remote-submit"));
    const registry = JSON.parse(
      localStorage.getItem("elizaos:agent-profiles")!,
    );
    expect(registry.profiles[0]).toEqual(oldProfile);
    expect(registry.profiles[1].accessToken).toBeUndefined();
    expect(mocks.repointBaseUrl).toHaveBeenCalledWith(
      "http://10.0.0.242:31725",
      null,
    );
    expect(localStorage.getItem("eliza:chat:activeConversationId")).toBe(
      "original-conversation",
    );
    expect(localStorage.getItem("pairing-history")).toBe(
      "keep-original-pairing",
    );
    expect(mocks.startFreshFirstRunReload).not.toHaveBeenCalled();
    localStorage.clear();
  });

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

  it.each(["backend-unreachable", "backend-timeout"] as const)(
    "keeps %s recovery on Retry without a first-run reset",
    (reason) => {
      const retry = vi.fn();
      render(
        <StartupFailureView
          error={{
            reason,
            message:
              "Previously configured backend is unreachable. Check your connection and retry.",
            phase: "starting-backend",
          }}
          onRetry={retry}
        />,
      );

      expect(screen.queryByTestId("startup-start-over")).toBeNull();
      expect(screen.queryByTestId("startup-use-cloud")).toBeNull();
      expect(
        screen.getByText(/Your connection settings are kept/),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));

      expect(retry).toHaveBeenCalledTimes(1);
      expect(mocks.startFreshFirstRunReload).not.toHaveBeenCalled();
    },
  );
});
