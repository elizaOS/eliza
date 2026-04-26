// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getLifeOpsAppState: vi.fn(async () => ({
      featureFlags: {
        emailClassifierEnabled: true,
      },
    })),
    getLifeOpsSmartFeatureSettings: vi.fn(async () => ({
      emailClassifierEnabled: true,
    })),
    getOnboardingOptions: vi.fn(async () => ({
      models: [],
    })),
  },
}));

vi.mock("@elizaos/app-core", () => ({
  Button: "button",
  client: clientMock,
  SegmentedControl: ({
    items,
    onValueChange,
    value,
  }: {
    items: Array<{ label: ReactNode; value: string }>;
    onValueChange: (value: string) => void;
    value: string;
  }) => (
    <div>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          onClick={() => onValueChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
  useApp: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
  }),
}));

vi.mock("../hooks/useGoogleLifeOpsConnector", () => ({
  useGoogleLifeOpsConnector: ({ side }: { side: "owner" | "agent" }) => ({
    accounts: [],
    actionPending: false,
    activeMode: "cloud_managed",
    connect: vi.fn(),
    connectAdditional: vi.fn(),
    disconnect: vi.fn(),
    disconnectAccount: vi.fn(),
    error: null,
    loading: false,
    pendingAuthUrl: null,
    refresh: vi.fn(),
    selectMode: vi.fn(),
    status: {
      connected: false,
      defaultMode: "cloud_managed",
      grant: null,
      grantedCapabilities: [],
      grantedScopes: [],
      hasCredentials: false,
      identity: null,
      mode: "cloud_managed",
      provider: "google",
      reason: "token_missing",
      side,
    },
  }),
}));

vi.mock("./BrowserBridgeSetupPanel.tsx", () => ({
  BrowserBridgeSetupPanel: () => <div data-testid="browser-bridge-setup" />,
}));

vi.mock("./LifeOpsFeatureTogglesSection", () => ({
  LifeOpsFeatureTogglesSection: () => <div data-testid="feature-toggles" />,
}));

vi.mock("./MobileSignalsSetupCard", () => ({
  MobileSignalsSetupCard: () => <div data-testid="mobile-signals" />,
}));

import { LifeOpsSettingsSection } from "./LifeOpsSettingsSection.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsSettingsSection", () => {
  it("renders the setup route shell and loads smart setting state", async () => {
    render(
      <LifeOpsSettingsSection
        ownerGithub={{ identity: "Owner GitHub", status: "Connected" }}
        agentGithub={{ identity: "Agent GitHub", status: "Connected" }}
      />,
    );

    expect(screen.getByTestId("mobile-signals")).toBeTruthy();
    expect(screen.getByTestId("browser-bridge-setup")).toBeTruthy();
    expect(screen.getByTestId("feature-toggles")).toBeTruthy();
    await waitFor(() =>
      expect(clientMock.getLifeOpsSmartFeatureSettings).toHaveBeenCalled(),
    );
  });
});
