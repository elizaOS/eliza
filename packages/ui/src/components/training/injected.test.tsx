// @vitest-environment jsdom
/**
 * Behaviour coverage for the injected FineTuningView: renders the host-supplied
 * `bootConfig.fineTuningView` when present, and the install hint when absent.
 * Real render in jsdom with a stubbed boot context.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentButton } from "../../agent-surface";
import { DEFAULT_BOOT_CONFIG } from "../../config/boot-config";
import { AppBootContext } from "../../config/boot-config-react.hooks";
import { invokeViewInteract } from "../views/view-interact-registry";
import { FineTuningView } from "./injected";

const sendWsMessage = vi.hoisted(() => vi.fn());
vi.mock("../../api", () => ({ client: { sendWsMessage } }));

afterEach(cleanup);
beforeEach(() => sendWsMessage.mockClear());

describe("trunk FineTuningView wrapper", () => {
  it("renders the dashboard the host injects through bootConfig.fineTuningView", () => {
    // The real dashboard ships in @elizaos/plugin-training; the host injects it.
    function PluginFineTuningDashboard() {
      return <div data-testid="plugin-fine-tuning">plugin dashboard</div>;
    }
    render(
      <AppBootContext.Provider
        value={{
          ...DEFAULT_BOOT_CONFIG,
          fineTuningView: PluginFineTuningDashboard,
        }}
      >
        <FineTuningView />
      </AppBootContext.Provider>,
    );
    expect(screen.getByTestId("plugin-fine-tuning")).toBeTruthy();
  });

  it("mounts the injected dashboard inside the fine-tuning agent surface", async () => {
    function PluginFineTuningDashboard() {
      return (
        <AgentButton agentId="start-training" agentLabel="Start training">
          Start
        </AgentButton>
      );
    }
    render(
      <AppBootContext.Provider
        value={{
          ...DEFAULT_BOOT_CONFIG,
          fineTuningView: PluginFineTuningDashboard,
        }}
      >
        <FineTuningView />
      </AppBootContext.Provider>,
    );

    await waitFor(async () => {
      const result = await invokeViewInteract(
        "fine-tuning",
        "gui",
        "list-elements",
      );
      expect((result as Array<{ id: string }>).map((e) => e.id)).toContain(
        "start-training",
      );
    });
  });

  it("shows an install hint (no trunk fallback dashboard) when the Training plugin is absent", () => {
    // The trunk owns no training dashboard: with nothing injected the wrapper
    // must not render a baked-in fallback, only the install hint.
    render(
      <AppBootContext.Provider value={{ ...DEFAULT_BOOT_CONFIG }}>
        <FineTuningView />
      </AppBootContext.Provider>,
    );
    expect(screen.getByText(/requires the Training plugin/i)).toBeTruthy();
  });
});
