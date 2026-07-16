/** Covers provider-panel selection controls and their distinct degraded states. */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiKeyPanel,
  CloudPanel,
  LocalProviderPanel,
  SubscriptionPanel,
} from "./ProviderPanels";

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, vars?: Record<string, unknown>) => string;
    }) => unknown,
  ) => selector({ t: (key, vars) => String(vars?.defaultValue ?? key) }),
}));
vi.mock("../accounts/AccountList", () => ({
  AccountList: ({ providerId }: { providerId: string }) => (
    <div>accounts:{providerId}</div>
  ),
}));
vi.mock("../local-inference/LocalInferencePanel", () => ({
  LocalInferencePanel: () => <div>local inference</div>,
}));
vi.mock("./ApiKeyConfig", () => ({
  ApiKeyConfig: () => <div>api key config</div>,
}));
vi.mock("./ProviderRoutingPanel", () => ({
  ProviderRoutingPanel: ({
    showCloudControls,
  }: {
    showCloudControls: boolean;
  }) => <div>cloud controls:{String(showCloudControls)}</div>,
}));
vi.mock("./settings-agent-rows", () => ({
  SettingsActionButton: ({
    agentId: _agentId,
    agentStatus: _agentStatus,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    agentId?: string;
    agentStatus?: string;
  }) => <button {...props} />,
}));

describe("ProviderPanels", () => {
  afterEach(cleanup);

  it("activates local and cloud routing", () => {
    const local = vi.fn();
    const cloud = vi.fn();
    const { rerender } = render(
      <LocalProviderPanel
        cloudCallsDisabled={false}
        routingModeSaving={false}
        onSelectLocalOnly={local}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use local only" }));
    expect(local).toHaveBeenCalled();
    rerender(
      <CloudPanel
        cloudCallsDisabled={false}
        isCloudSelected={false}
        routingModeSaving={false}
        onSelectCloud={cloud}
        elizaCloudConnected
        largeModelOptions={[]}
        cloudModelSchema={null}
        modelValues={{ values: {}, setKeys: new Set() }}
        currentLargeModel=""
        modelSaving={false}
        modelSaveSuccess={false}
        onModelFieldChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use Eliza Cloud" }));
    expect(cloud).toHaveBeenCalled();
    expect(screen.getByText("cloud controls:false")).toBeTruthy();
  });

  it("shows and activates a paused subscription", () => {
    const select = vi.fn().mockResolvedValue(undefined);
    render(
      <SubscriptionPanel
        selection={
          {
            id: "openai-subscription",
            storedProvider: "openai-codex",
            labelKey: "Codex",
          } as never
        }
        visibleProviderPanelId="openai-subscription"
        resolvedSelectedId="openai-subscription"
        cloudCallsDisabled
        onSelectSubscription={select}
      />,
    );
    expect(screen.getByText(/remote routing is paused/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use subscription" }));
    expect(select).toHaveBeenCalledWith("openai-subscription");
    expect(screen.getByText("accounts:openai-codex")).toBeTruthy();
  });

  it("shows and activates a paused API-key provider", () => {
    const select = vi.fn();
    render(
      <ApiKeyPanel
        selectedProvider={{ id: "plugin-openai" } as never}
        panelLabel="OpenAI"
        visibleProviderPanelId="plugin-openai"
        resolvedSelectedId={null}
        cloudCallsDisabled
        onSwitchProvider={select}
        pluginSaving={new Set()}
        pluginSaveSuccess={new Set()}
        handlePluginConfigSave={vi.fn()}
        loadPlugins={vi.fn()}
      />,
    );
    expect(screen.getByText(/remote routing is paused/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use provider" }));
    expect(select).toHaveBeenCalledWith("plugin-openai");
    expect(screen.getByText("api key config")).toBeTruthy();
  });
});
