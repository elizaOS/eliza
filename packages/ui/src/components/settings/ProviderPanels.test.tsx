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
    agentLabel: _agentLabel,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    agentId?: string;
    agentStatus?: string;
    agentLabel?: string;
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
        onSignIn={vi.fn()}
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

  it("does not mark Cloud active when selected but not signed in (#20045)", () => {
    const signIn = vi.fn();
    render(
      <CloudPanel
        cloudCallsDisabled={false}
        isCloudSelected
        routingModeSaving={false}
        onSelectCloud={vi.fn()}
        onSignIn={signIn}
        elizaCloudConnected={false}
        largeModelOptions={[]}
        cloudModelSchema={null}
        modelValues={{ values: {}, setKeys: new Set() }}
        currentLargeModel=""
        modelSaving={false}
        modelSaveSuccess={false}
        onModelFieldChange={vi.fn()}
      />,
    );
    // Unsigned-in Cloud is inspect-only: the action must sign the user in,
    // not pretend the cloud route is live or no-op on switchProvider.
    expect(
      screen.getByRole("button", { name: "Sign in to Eliza Cloud" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cloud active" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use Eliza Cloud" }),
    ).toBeNull();
    expect(screen.queryByText(/cloud controls/)).toBeNull();
    expect(
      screen.getByText(
        "Eliza Cloud isn't signed in. Chat replies are using Local.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in to Eliza Cloud" }),
    );
    expect(signIn).toHaveBeenCalled();
  });

  it("marks Cloud active when selected AND signed in", () => {
    render(
      <CloudPanel
        cloudCallsDisabled={false}
        isCloudSelected
        routingModeSaving={false}
        onSelectCloud={vi.fn()}
        onSignIn={vi.fn()}
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
    expect(screen.getByRole("button", { name: "Cloud active" })).toBeTruthy();
    expect(screen.getByText("cloud controls:true")).toBeTruthy();
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
    expect(screen.getByText(/remote routing is paused/i)).toBeTruthy();
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
    expect(screen.getByText(/remote routing is paused/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use provider" }));
    expect(select).toHaveBeenCalledWith("plugin-openai");
    expect(screen.getByText("api key config")).toBeTruthy();
  });

  it("explains Local fallback when Cloud is unsigned-in", () => {
    render(
      <LocalProviderPanel
        cloudCallsDisabled={false}
        routingModeSaving={false}
        onSelectLocalOnly={vi.fn()}
        servingFallback
      />,
    );
    expect(
      screen.getByText("Answering chat because Eliza Cloud isn't signed in."),
    ).toBeTruthy();
  });
});
