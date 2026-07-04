// @vitest-environment jsdom
//
// TerminalPluginView: renders the typed TUI status surface, falls back to
// default commands, runs a command via keyboard/click (asserting the POST body
// and the `eliza:tui-command` event), and shows failures in the transcript.
// `fetchWithCsrf` is mocked; the component and its interact wiring are real.

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../../api/csrf-client";
import { TerminalPluginView } from "./TerminalPluginView";

vi.mock("../../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(fetchWithCsrf).mockReset();
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
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe(
      "Inspect balances from a terminal surface.",
    );
    expect(screen.getByText("refresh-balances")).toBeTruthy();
    expect(screen.getByText("/api/wallet/balances")).toBeTruthy();

    const stateElement = container.querySelector("[data-view-state]");
    expect(stateElement).toBeTruthy();
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toEqual({
      viewType: "tui",
      viewId: "wallet",
      label: "Wallet",
      commandCount: 2,
      endpointCount: 1,
    });
  });

  it("uses default terminal commands when none are provided", () => {
    render(<TerminalPluginView id="messages" label="Messages" />);

    expect(screen.getByText("get-state")).toBeTruthy();
    expect(screen.getByText("get-text")).toBeTruthy();
    expect(screen.getByText("refresh")).toBeTruthy();
  });

  it("exposes commands as keyboard-selectable terminal controls", async () => {
    vi.mocked(fetchWithCsrf).mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { ok: true } }), {
        status: 200,
      }),
    );
    const events: unknown[] = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent).detail);
    };
    window.addEventListener("eliza:tui-command", handler);

    try {
      render(
        <TerminalPluginView
          id="model-tester"
          label="Model Tester"
          commands={["run-all-probes", "open-history"]}
        />,
      );

      const firstCommand = screen.getByRole("button", {
        name: "Run run-all-probes",
      });
      firstCommand.focus();
      expect(document.activeElement).toBe(firstCommand);

      await userEvent.keyboard("{Enter}");
      expect(events).toEqual([
        { viewId: "model-tester", command: "run-all-probes" },
      ]);
      expect(fetchWithCsrf).toHaveBeenCalledWith(
        "/api/views/model-tester/interact?viewType=tui",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            capability: "run-all-probes",
            timeoutMs: 5_000,
          }),
        },
      );
      expect(await screen.findByText(/"ok": true/)).toBeTruthy();
    } finally {
      window.removeEventListener("eliza:tui-command", handler);
    }
  });

  it("renders command failures in the terminal transcript", async () => {
    vi.mocked(fetchWithCsrf).mockResolvedValue(
      new Response(JSON.stringify({ error: "unsupported capability" }), {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    render(
      <TerminalPluginView id="wallet" label="Wallet" commands={["swap"]} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Run swap" }));

    expect(await screen.findByText(/unsupported capability/)).toBeTruthy();
    expect(
      document.querySelector('[data-terminal-output="error"]'),
    ).toBeTruthy();
  });
});
