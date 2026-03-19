// @vitest-environment jsdom

import React, { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    hasToken: vi.fn(() => false),
    getCodingAgentStatus: vi.fn(async () => null),
    setToken: vi.fn(),
    getAuthStatus: vi.fn(async () => ({
      required: false,
      pairingEnabled: false,
      expiresAt: null,
    })),
    getOnboardingStatus: vi.fn(async () => ({ complete: true })),
    disconnectWs: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

import { AppProvider, useApp } from "@elizaos/app-core/state";

interface StartupSnapshot {
  onboardingLoading: boolean;
  authRequired: boolean;
  startupError: ReturnType<typeof useApp>["startupError"];
}

function Probe(props: { onChange: (snapshot: StartupSnapshot) => void }) {
  const app = useApp();
  useEffect(() => {
    props.onChange({
      onboardingLoading: app.onboardingLoading,
      authRequired: app.authRequired,
      startupError: app.startupError,
    });
  }, [
    app.onboardingLoading,
    app.authRequired,
    app.startupError,
    props.onChange,
  ]);
  return null;
}

describe("startup failure: backend missing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(document.documentElement, { setAttribute: vi.fn() });
    // Simulate a returning user with a persisted local connection so the
    // startup flow proceeds to backend polling (fresh installs now skip
    // backend polling and go straight to onboarding).
    localStorage.setItem(
      "eliza:connection-mode",
      JSON.stringify({ runMode: "local" }),
    );
    mockClient.hasToken.mockReturnValue(false);
    mockClient.disconnectWs.mockImplementation(() => {});
    mockClient.getAuthStatus.mockResolvedValue({
      required: false,
      pairingEnabled: false,
      expiresAt: null,
    });
    const err = Object.assign(
      new Error("Backend API routes are unavailable on this origin"),
      {
        kind: "http",
        status: 404,
        path: "/api/onboarding/status",
      },
    );
    mockClient.getOnboardingStatus.mockRejectedValue(err);
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem("eliza:connection-mode");
  });

  it("fails fast on backend 404 and surfaces backend-unreachable", async () => {
    let latest: StartupSnapshot | null = null;
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onChange: (snapshot) => {
              latest = snapshot;
            },
          }),
        ),
      );
    });

    await act(async () => {
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
    });

    expect(latest).not.toBeNull();
    expect(latest?.onboardingLoading).toBe(false);
    expect(latest?.authRequired).toBe(false);
    expect(latest?.startupError?.reason).toBe("backend-unreachable");
    expect(latest?.startupError?.phase).toBe("starting-backend");
    expect(latest?.startupError?.message).toContain(
      "Backend API routes are unavailable on this origin",
    );
    expect(latest?.startupError?.status).toBe(404);
    expect(latest?.startupError?.path).toBe("/api/onboarding/status");
    expect(mockClient.getAuthStatus).toHaveBeenCalledTimes(1);
    expect(mockClient.getOnboardingStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree?.unmount();
    });
  });
});
