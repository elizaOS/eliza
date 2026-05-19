// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalPluginView } from "./TerminalPluginView";

afterEach(() => {
  cleanup();
});

describe("TerminalPluginView", () => {
  it("mounts a typed TUI status surface with commands and endpoints", () => {
    const { container } = render(
      <TerminalPluginView
        id="wallet"
        label="Wallet"
        description="Inspect balances from a terminal surface."
        commands={["get-state", "refresh-balances"]}
        endpoints={["/api/wallet/balances"]}
      />,
    );

    expect(screen.getByText("elizaos://wallet --type=tui")).toBeTruthy();
    expect(screen.getByText("Wallet")).toBeTruthy();
    expect(
      screen.getByText("Inspect balances from a terminal surface."),
    ).toBeTruthy();
    expect(screen.getByText("refresh-balances")).toBeTruthy();
    expect(screen.getByText("/api/wallet/balances")).toBeTruthy();

    const stateElement = container.querySelector("[data-view-state]");
    expect(stateElement).toBeTruthy();
    expect(JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}")).toEqual(
      {
        viewType: "tui",
        viewId: "wallet",
        label: "Wallet",
        commandCount: 2,
        endpointCount: 1,
      },
    );
  });

  it("uses default terminal commands when none are provided", () => {
    render(<TerminalPluginView id="messages" label="Messages" />);

    expect(screen.getByText("get-state")).toBeTruthy();
    expect(screen.getByText("get-text")).toBeTruthy();
    expect(screen.getByText("refresh")).toBeTruthy();
  });
});
