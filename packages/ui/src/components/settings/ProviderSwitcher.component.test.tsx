/** Exercises the provider switcher's composition and selection wiring. */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Cloud, Cpu, KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSwitcher } from "./ProviderSwitcher";

const selection = vi.hoisted(() => ({
  cloudCallsDisabled: false,
  handleProviderPanelSelect: vi.fn(),
  handleSelectCloud: vi.fn(),
  handleSelectLocalOnly: vi.fn(),
  handleSelectSubscription: vi.fn(),
  handleSwitchProvider: vi.fn(),
  isCloudSelected: false,
  resolvedSelectedId: "anthropic-subscription",
  routingModeSaving: false,
  visibleProviderPanelId: "__local__",
}));

vi.mock("../../hooks/useDefaultProviderPresets", () => ({
  useDefaultProviderPresets: vi.fn(),
}));
vi.mock("../../state", () => ({
  useAppSelectorShallow: (
    selector: (state: Record<string, unknown>) => unknown,
  ) =>
    selector({
      t: (key: string, vars?: Record<string, unknown>) =>
        String(vars?.defaultValue ?? key),
      plugins: [],
      setActionNotice: vi.fn(),
    }),
}));
vi.mock("./useProviderSelection", () => ({
  resolveProviderIdForSwitch: (id: string) => id,
  useProviderSelection: () => selection,
}));
vi.mock("./useCloudModelConfig", () => ({
  useCloudModelConfig: () => ({
    largeModelOptions: [],
    cloudModelSchema: null,
    modelValues: { values: {}, setKeys: new Set() },
    currentLargeModel: "",
    modelSaving: false,
    modelSaveSuccess: false,
    handleModelFieldChange: vi.fn(),
  }),
}));
vi.mock("./useProviderBootstrap", () => ({
  useProviderBootstrap: () => ({
    subscriptionStatus: {},
    anthropicCliDetected: false,
  }),
}));
vi.mock("./useProviderEntries", () => ({
  computeAvailableProviderIds: () => new Set(),
  sortAiProviders: (items: unknown[]) => items,
  useProviderEntries: () => ({
    apiProviderChoices: [
      {
        id: "openai",
        label: "OpenAI",
        provider: { id: "plugin-openai", name: "OpenAI" },
      },
    ],
    providerEntries: [
      {
        id: "__cloud__",
        icon: Cloud,
        label: "Cloud",
        category: "cloud",
        status: { tone: "ok", label: "Ready" },
        current: false,
      },
      {
        id: "__local__",
        icon: Cpu,
        label: "Local",
        category: "local",
        status: { tone: "ok", label: "Ready" },
        current: false,
      },
      {
        id: "anthropic-subscription",
        icon: KeyRound,
        label: "Claude Subscription",
        category: "subscription",
        status: { tone: "ok", label: "Ready" },
        current: true,
      },
      {
        id: "openai",
        icon: KeyRound,
        label: "OpenAI",
        category: "key",
        status: { tone: "idle", label: "Setup" },
        current: false,
      },
    ],
  }),
}));

vi.mock("./ProviderCard", () => ({
  ProviderCard: ({
    label,
    onSelect,
    id,
  }: {
    label: string;
    id: string;
    onSelect: (id: string) => void;
  }) => (
    <button type="button" onClick={() => onSelect(id)}>
      {label}
    </button>
  ),
}));
vi.mock("./ProviderPanels", () => ({
  LocalProviderPanel: ({
    onSelectLocalOnly,
  }: {
    onSelectLocalOnly: () => void;
  }) => (
    <button type="button" onClick={onSelectLocalOnly}>
      local panel
    </button>
  ),
  CloudPanel: ({ onSelectCloud }: { onSelectCloud: () => void }) => (
    <button type="button" onClick={onSelectCloud}>
      cloud panel
    </button>
  ),
  ApiKeyPanel: () => <div>API panel</div>,
}));
vi.mock("../accounts/AccountManagementPanel", () => ({
  AccountManagementPanel: () => <div>accounts panel</div>,
}));
vi.mock("../local-inference/ProvidersList", () => ({
  ProvidersList: () => <div>providers list</div>,
}));
vi.mock("../local-inference/RoutingMatrix", () => ({
  RoutingMatrix: () => <div>routing matrix</div>,
}));
vi.mock("./ModelConfigurationPanel", () => ({
  ModelConfigurationPanel: () => <div>model config</div>,
}));
vi.mock("./settings-control-primitives", () => ({
  AdvancedSettingsDisclosure: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

describe("ProviderSwitcher", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    selection.visibleProviderPanelId = "__local__";
  });

  it("renders the grouped surface and activates local selection", () => {
    render(<ProviderSwitcher />);
    expect(screen.getByText("Active for coding agents")).toBeTruthy();
    expect(screen.getByText("accounts panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "local panel" }));
    expect(selection.handleSelectLocalOnly).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cloud" }));
    expect(selection.handleProviderPanelSelect).toHaveBeenCalledWith(
      "__cloud__",
    );
  });

  it("renders the cloud panel and activates cloud routing", () => {
    selection.visibleProviderPanelId = "__cloud__";
    render(<ProviderSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: "cloud panel" }));
    expect(selection.handleSelectCloud).toHaveBeenCalled();
  });
});
