/** Exercises the provider switcher's composition and selection wiring. */

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Cloud, Cpu, KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderSwitcher,
  reconcileProviderEntriesWithServingAxes,
} from "./ProviderSwitcher";

const selection = vi.hoisted(() => ({
  cloudCallsDisabled: false,
  cloudRuntimeLocked: false,
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
const getModelsConfig = vi.hoisted(() =>
  vi.fn(async () => ({
    targets: { small: {}, large: {}, coding: {} },
    activeChat: {
      provider: "elizacloud",
      family: "ELIZAOS_CLOUD",
      endpoint: "api.eliza.app",
    },
  })),
);

vi.mock("../../hooks/useDefaultProviderPresets", () => ({
  useDefaultProviderPresets: vi.fn(),
}));
// The serving summary reads the runtime axis from GET /api/runtime/mode and
// the inference axis from activeChat on GET /api/models/config.
vi.mock("../../hooks/useRuntimeMode", () => ({
  useRuntimeMode: () => ({
    state: {
      phase: "ready",
      snapshot: {
        mode: selection.cloudRuntimeLocked ? "cloud" : "local",
        deploymentRuntime: selection.cloudRuntimeLocked ? "cloud" : "local",
      },
    },
  }),
}));
vi.mock("../../api", () => ({
  client: {
    getBaseUrl: vi.fn(() =>
      selection.cloudRuntimeLocked
        ? "https://api.eliza.app/api/v1/eliza/agents/shared"
        : "http://127.0.0.1:31337",
    ),
    getModelsConfig,
  },
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
      // The serving-axes summary reads the runtime axis from these; the real
      // store always supplies startupCoordinator, so the stub must too.
      firstRunRuntimeTarget: "",
      startupCoordinator: { target: "embedded-local" },
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
    selection.cloudRuntimeLocked = false;
  });

  it("states both serving axes above the intelligence tiles", async () => {
    render(<ProviderSwitcher />);
    // Tiles alone cannot distinguish a hosted agent from Cloud models, so the
    // runtime axis must be wired in, not just available (#20045 follow-up).
    expect(screen.getByTestId("serving-runtime-value").textContent).toBe(
      "This device",
    );
    // Inference resolves from the server's activeChat, so it reads "Checking…"
    // until that lands — never a fabricated "This device".
    expect(screen.getByTestId("serving-inference-value").textContent).toBe(
      "Checking…",
    );
    await waitFor(() => {
      expect(screen.getByTestId("serving-inference-value").textContent).toBe(
        "This device",
      );
    });
  });

  it("renders the grouped surface and activates local selection", async () => {
    render(<ProviderSwitcher />);
    // Let the activeChat fetch settle so its state update stays inside act().
    await waitFor(() => {
      expect(screen.getByTestId("serving-inference-value").textContent).toBe(
        "This device",
      );
    });
    expect(screen.getByText("Active for coding agents")).toBeTruthy();
    expect(screen.getByText("accounts panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "local panel" }));
    expect(selection.handleSelectLocalOnly).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cloud" }));
    expect(selection.handleProviderPanelSelect).toHaveBeenCalledWith(
      "__cloud__",
    );
  });

  it("renders the cloud panel and activates cloud routing", async () => {
    selection.visibleProviderPanelId = "__cloud__";
    render(<ProviderSwitcher />);
    await waitFor(() => {
      expect(screen.getByTestId("serving-inference-value").textContent).toBe(
        "This device",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "cloud panel" }));
    expect(selection.handleSelectCloud).toHaveBeenCalled();
  });

  it("uses the live external serving source for Active provider labels", () => {
    const entries = [
      {
        id: "__local__",
        icon: Cpu,
        label: "Local",
        category: "local" as const,
        status: { tone: "ok" as const, label: "Active" },
        current: true,
      },
      {
        id: "cerebras",
        icon: KeyRound,
        label: "Cerebras",
        category: "key" as const,
        status: { tone: "ok" as const, label: "Ready" },
        current: false,
      },
    ];

    const displayed = reconcileProviderEntriesWithServingAxes(entries, {
      runtime: "local",
      inference: "external",
      combination: "external-inference",
      inferenceFallback: false,
      activeChatProvider: "cerebras",
      activeChatEndpoint: "api.cerebras.ai",
    });

    expect(displayed.find((entry) => entry.id === "__local__")?.current).toBe(
      false,
    );
    expect(displayed.find((entry) => entry.id === "__local__")?.status).toEqual(
      { tone: "muted", label: "Available" },
    );
    expect(displayed.find((entry) => entry.id === "cerebras")?.current).toBe(
      true,
    );
  });

  it("preserves a non-serving provider warning under external routing", () => {
    const entries = [
      {
        id: "__cloud__",
        icon: Cloud,
        label: "Eliza Cloud",
        category: "cloud" as const,
        status: { tone: "warn" as const, label: "Not signed in" },
        current: false,
      },
    ];

    const displayed = reconcileProviderEntriesWithServingAxes(entries, {
      runtime: "local",
      inference: "external",
      combination: "external-inference",
      inferenceFallback: false,
      activeChatProvider: "cerebras",
      activeChatEndpoint: "api.cerebras.ai",
    });

    expect(displayed[0]?.status).toEqual({
      tone: "warn",
      label: "Not signed in",
    });
  });

  it("does not advertise local inference or model controls in a Cloud-only build", async () => {
    selection.cloudRuntimeLocked = true;
    render(<ProviderSwitcher elizaCloudConnected />);

    await waitFor(() => {
      expect(screen.getByTestId("serving-runtime-value").textContent).toBe(
        "Eliza Cloud",
      );
      expect(screen.getByTestId("serving-inference-value").textContent).toBe(
        "Eliza Cloud",
      );
    });

    expect(screen.queryByRole("button", { name: "Local" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cloud" })).toBeNull();
    expect(screen.queryByText("local panel")).toBeNull();
    expect(screen.queryByText("accounts panel")).toBeNull();
    expect(screen.queryByText("providers list")).toBeNull();
    expect(screen.queryByText("routing matrix")).toBeNull();
    expect(screen.queryByText("model config")).toBeNull();
    expect(getModelsConfig).not.toHaveBeenCalled();
    expect(screen.getByText("Eliza Cloud voice")).toBeTruthy();
  });
});
