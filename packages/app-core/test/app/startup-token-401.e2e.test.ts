// @vitest-environment jsdom

import React, { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    hasToken: vi.fn(() => true),
    getCodingAgentStatus: vi.fn(async () => null),
    setToken: vi.fn(),
    getAuthStatus: vi.fn(async () => ({
      required: true,
      pairingEnabled: true,
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

describe("startup stale token handling", () => {
  beforeEach(() => {
    Object.assign(document.documentElement, { setAttribute: vi.fn() });
    mockClient.hasToken.mockReturnValue(true);
    mockClient.disconnectWs.mockImplementation(() => {});
    mockClient.getAuthStatus.mockResolvedValue({
      required: true,
      pairingEnabled: true,
      expiresAt: null,
    });
    const err = Object.assign(new Error("Unauthorized"), {
      kind: "http",
      status: 401,
      path: "/api/onboarding/status",
    });
    mockClient.getOnboardingStatus.mockRejectedValue(err);
  });

  it("clears stale token and exits to pairing/auth instead of retry loop", async () => {
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
      await Promise.resolve();
    });

    expect(mockClient.setToken).toHaveBeenCalledWith(null);
    expect(latest).not.toBeNull();
    expect(latest?.onboardingLoading).toBe(false);
    expect(latest?.authRequired).toBe(true);
    expect(latest?.startupError).toBeNull();

    await act(async () => {
      tree?.unmount();
    });
  });
});
