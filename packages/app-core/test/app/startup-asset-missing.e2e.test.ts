// @vitest-environment jsdom

import React, { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    getStatus: vi.fn(async () => ({
      state: "error",
      startup: {
        phase: "initializing-agent",
        attempt: 1,
        lastError: "Bundled avatar ELIZA-01 could not be loaded.",
      },
      pendingRestart: false,
      pendingRestartReasons: [],
    })),
    getConfig: vi.fn(async () => ({ ui: { avatarIndex: 1 } })),
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
  startupPhase: ReturnType<typeof useApp>["startupPhase"];
  startupError: ReturnType<typeof useApp>["startupError"];
}

function Probe(props: { onChange: (snapshot: StartupSnapshot) => void }) {
  const app = useApp();
  useEffect(() => {
    props.onChange({
      onboardingLoading: app.onboardingLoading,
      startupPhase: app.startupPhase,
      startupError: app.startupError,
    });
  }, [
    app.onboardingLoading,
    app.startupPhase,
    app.startupError,
    props.onChange,
  ]);
  return null;
}

describe("startup failure: bundled assets missing", () => {
  beforeEach(() => {
    Object.assign(document.documentElement, { setAttribute: vi.fn() });
    mockClient.hasToken.mockReturnValue(false);
    mockClient.disconnectWs.mockImplementation(() => {});
    mockClient.getAuthStatus.mockResolvedValue({
      required: false,
      pairingEnabled: false,
      expiresAt: null,
    });
    mockClient.getOnboardingStatus.mockResolvedValue({ complete: true });
    mockClient.getStatus.mockResolvedValue({
      state: "error",
      startup: {
        phase: "initializing-agent",
        attempt: 1,
        lastError: "Bundled avatar ELIZA-01 could not be loaded.",
      },
      pendingRestart: false,
      pendingRestartReasons: [],
    });
    mockClient.getConfig.mockResolvedValue({ ui: { avatarIndex: 1 } });
  });
  it("surfaces asset-missing before startup reaches ready", async () => {
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
      await Promise.resolve();
    });

    expect(latest).not.toBeNull();
    expect(latest?.onboardingLoading).toBe(false);
    expect(latest?.startupPhase).toBe("initializing-agent");
    expect(latest?.startupError?.reason).toBe("asset-missing");
    expect(latest?.startupError?.phase).toBe("initializing-agent");
    expect(latest?.startupError?.message).toContain(
      "Required companion assets could not be loaded",
    );
    expect(latest?.startupError?.detail).toContain(
      "Bundled avatar ELIZA-01 could not be loaded",
    );

    await act(async () => {
      tree?.unmount();
    });
  });
});
