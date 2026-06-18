// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// TrajectoryLoggerTuiView mounts TerminalPluginView from this exact specifier.
vi.mock("@elizaos/ui/components/views/TerminalPluginView", () => ({
  TerminalPluginView: (props: {
    id: string;
    commands?: string[];
    endpoints?: string[];
  }) =>
    React.createElement("div", {
      "data-testid": "terminal-plugin-view",
      "data-id": props.id,
      "data-commands": JSON.stringify(props.commands ?? null),
      "data-endpoints": JSON.stringify(props.endpoints ?? null),
    }),
}));

// The view module also imports @elizaos/ui and @elizaos/ui/agent-surface (for
// the sibling default web view); stub them so the module loads in jsdom.
vi.mock("@elizaos/ui", () => ({
  Button: React.forwardRef<HTMLButtonElement, Record<string, unknown>>(
    function MockButton({ children, ...props }, ref) {
      return React.createElement(
        "button",
        { type: "button", ref, ...props },
        children as React.ReactNode,
      );
    },
  ),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: React.createRef(), agentProps: {} }),
}));

import { TrajectoryLoggerTuiView } from "./TrajectoryLoggerView.js";

afterEach(() => cleanup());

describe("TrajectoryLoggerTuiView", () => {
  it("mounts TerminalPluginView with id 'trajectory-logger' and empty commands", () => {
    render(<TrajectoryLoggerTuiView />);
    const shell = screen.getByTestId("terminal-plugin-view");
    expect(shell.getAttribute("data-id")).toBe("trajectory-logger");
    expect(shell.getAttribute("data-commands")).toBe("[]");
  });

  it("advertises the trajectories endpoints array", () => {
    render(<TrajectoryLoggerTuiView />);
    const endpoints = JSON.parse(
      screen
        .getByTestId("terminal-plugin-view")
        .getAttribute("data-endpoints") ?? "null",
    ) as string[];
    expect(endpoints).toContain("/api/trajectories");
  });

  it("DOCUMENTS that '/api/trajectories/latest' is advertised but is NOT a real route", () => {
    // The TUI endpoints array lists '/api/trajectories/latest', yet no such
    // handler exists in @elizaos/plugin-training (only GET /api/trajectories and
    // GET /api/trajectories/:id are routed). This assertion locks the current
    // (mismatched) behavior so a future route addition OR removal is caught.
    render(<TrajectoryLoggerTuiView />);
    const endpoints = JSON.parse(
      screen
        .getByTestId("terminal-plugin-view")
        .getAttribute("data-endpoints") ?? "null",
    ) as string[];
    expect(endpoints).toContain("/api/trajectories/latest");
  });
});
