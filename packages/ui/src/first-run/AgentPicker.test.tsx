// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudCompatAgent } from "../api/client-types-cloud";
import { AgentPicker, type AgentPickerProps } from "./AgentPicker";

function agent(overrides: Partial<CloudCompatAgent> = {}): CloudCompatAgent {
  return {
    agent_id: "agent-1",
    agent_name: "Agent One",
    node_id: null,
    container_id: null,
    headscale_ip: null,
    bridge_url: null,
    web_ui_url: null,
    status: "running",
    agent_config: {},
    created_at: "2026-06-18T00:00:00.000Z",
    updated_at: "2026-06-18T00:00:00.000Z",
    containerUrl: "",
    webUiUrl: null,
    database_status: "ready",
    error_message: null,
    last_heartbeat_at: null,
    ...overrides,
  };
}

function props(overrides: Partial<AgentPickerProps> = {}): AgentPickerProps {
  return {
    agents: [agent()],
    activeAgentId: null,
    phase: "ready",
    errorMessage: null,
    bindingAgentId: null,
    onPick: vi.fn(),
    onCreateNew: vi.fn(),
    onRetry: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("AgentPicker", () => {
  it("renders a row + StatusBadge label per agent and picks a non-active row", () => {
    const onPick = vi.fn();
    render(
      <AgentPicker
        {...props({
          agents: [
            agent({ agent_id: "a1", agent_name: "Alpha", status: "running" }),
            agent({ agent_id: "a2", agent_name: "Bravo", status: "stopped" }),
          ],
          onPick,
        })}
      />,
    );

    expect(screen.getByTestId("onboarding-agent-picker")).toBeTruthy();
    expect(screen.getByTestId("onboarding-agent-option-a1")).toBeTruthy();
    expect(screen.getByTestId("onboarding-agent-option-a2")).toBeTruthy();
    // StatusBadge label is the title-cased status string.
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Stopped")).toBeTruthy();

    fireEvent.click(screen.getByTestId("onboarding-agent-option-a2"));
    expect(onPick).toHaveBeenCalledWith("a2");
  });

  it("marks the active agent row 'Active', disabled, and never calls onPick", () => {
    const onPick = vi.fn();
    render(
      <AgentPicker
        {...props({
          agents: [agent({ agent_id: "a1", agent_name: "Alpha" })],
          activeAgentId: "a1",
          onPick,
        })}
      />,
    );

    expect(screen.getByText("Active")).toBeTruthy();
    const row = screen.getByTestId<HTMLButtonElement>(
      "onboarding-agent-option-a1",
    );
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("shows a spinner and no rows while loading", () => {
    render(<AgentPicker {...props({ phase: "loading" })} />);

    expect(screen.getByTestId("onboarding-agent-loading")).toBeTruthy();
    expect(screen.queryByTestId("onboarding-agent-option-agent-1")).toBeNull();
  });

  it("shows the error message with wired Retry and Back in the error phase", () => {
    const onRetry = vi.fn();
    const onBack = vi.fn();
    render(
      <AgentPicker
        {...props({
          phase: "error",
          errorMessage: "Could not load your agents.",
          onRetry,
          onBack,
        })}
      />,
    );

    expect(screen.getByText("Could not load your agents.")).toBeTruthy();
    expect(screen.queryByTestId("onboarding-agent-option-agent-1")).toBeNull();
    fireEvent.click(screen.getByTestId("onboarding-agent-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("onboarding-agent-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("disables rows and Create while binding", () => {
    const onPick = vi.fn();
    const onCreateNew = vi.fn();
    render(
      <AgentPicker
        {...props({
          agents: [agent({ agent_id: "a1" })],
          phase: "binding",
          bindingAgentId: "a1",
          onPick,
          onCreateNew,
        })}
      />,
    );

    const row = screen.getByTestId<HTMLButtonElement>(
      "onboarding-agent-option-a1",
    );
    expect(row.disabled).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("onboarding-agent-create").disabled,
    ).toBe(true);
    fireEvent.click(row);
    fireEvent.click(screen.getByTestId("onboarding-agent-create"));
    expect(onPick).not.toHaveBeenCalled();
    expect(onCreateNew).not.toHaveBeenCalled();
  });

  it("disables a deletion_pending row and labels it 'Deleting'", () => {
    const onPick = vi.fn();
    render(
      <AgentPicker
        {...props({
          agents: [agent({ agent_id: "a1", status: "deletion_pending" })],
          onPick,
        })}
      />,
    );

    expect(screen.getByText("Deleting")).toBeTruthy();
    const row = screen.getByTestId<HTMLButtonElement>(
      "onboarding-agent-option-a1",
    );
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("calls onCreateNew from the Create button", () => {
    const onCreateNew = vi.fn();
    render(<AgentPicker {...props({ onCreateNew })} />);

    fireEvent.click(screen.getByTestId("onboarding-agent-create"));
    expect(onCreateNew).toHaveBeenCalledTimes(1);
  });
});
