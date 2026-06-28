// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listConnectorAccountsMock, getInboxMessagesMock } = vi.hoisted(() => ({
  listConnectorAccountsMock: vi.fn(),
  getInboxMessagesMock: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: {
    listConnectorAccounts: listConnectorAccountsMock,
    getInboxMessages: getInboxMessagesMock,
  },
}));

// useWidgetNavigation → reportUserViewSwitch (from the slash-command
// controller); stub it so the click test isolates the navigation rail (the
// CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

import { DiscordRecentWidget } from "./discord-recent";

function connectedAccounts() {
  return {
    provider: "discord",
    connectorId: "discord",
    accounts: [
      {
        id: "a-1",
        provider: "discord",
        connectorId: "discord",
        label: "Guild",
        status: "connected",
      },
    ],
  };
}

function noAccounts() {
  return { provider: "discord", connectorId: "discord", accounts: [] };
}

function discordMessage(text: string) {
  return {
    id: "m-1",
    role: "user" as const,
    text,
    timestamp: 0,
    roomId: "r-1",
    source: "discord",
  };
}

describe("DiscordRecentWidget", () => {
  beforeEach(() => {
    listConnectorAccountsMock.mockReset();
    getInboxMessagesMock.mockReset();
  });
  afterEach(() => cleanup());

  it("renders a loading strip before the probe resolves", () => {
    listConnectorAccountsMock.mockReturnValue(new Promise(() => {}));
    render(<DiscordRecentWidget />);
    expect(
      screen.getByTestId("chat-widget-discord-recent-loading"),
    ).toBeTruthy();
  });

  it("shows the most-recent message preview and count badge when connected", async () => {
    listConnectorAccountsMock.mockResolvedValue(connectedAccounts());
    getInboxMessagesMock.mockResolvedValue({
      messages: [discordMessage("gm everyone"), discordMessage("older")],
      count: 7,
    });
    render(<DiscordRecentWidget />);
    await waitFor(() =>
      expect(screen.getByTestId("chat-widget-discord-recent")).toBeTruthy(),
    );
    expect(screen.getByText("gm everyone")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(getInboxMessagesMock).toHaveBeenCalledWith({
      sources: ["discord"],
      limit: 5,
    });
  });

  it("shows the connected-empty state when there are no messages", async () => {
    listConnectorAccountsMock.mockResolvedValue(connectedAccounts());
    getInboxMessagesMock.mockResolvedValue({ messages: [], count: 0 });
    render(<DiscordRecentWidget />);
    await waitFor(() =>
      expect(screen.getByText("No recent messages")).toBeTruthy(),
    );
  });

  it("renders the connect affordance and navigates when no account is connected", async () => {
    listConnectorAccountsMock.mockResolvedValue(noAccounts());
    const navSpy = vi.fn();
    window.addEventListener("eliza:navigate:view", navSpy);
    render(<DiscordRecentWidget />);
    const connect = await screen.findByTestId(
      "chat-widget-discord-recent-connect",
    );
    expect(screen.getByText("Connect Discord")).toBeTruthy();
    expect(getInboxMessagesMock).not.toHaveBeenCalled();
    fireEvent.click(connect);
    expect(navSpy).toHaveBeenCalledTimes(1);
    const detail = (navSpy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ viewPath: "/settings/connectors" });
    window.removeEventListener("eliza:navigate:view", navSpy);
  });

  it("falls back to the connect affordance when the probe throws", async () => {
    listConnectorAccountsMock.mockRejectedValue(new Error("boom"));
    render(<DiscordRecentWidget />);
    await waitFor(() =>
      expect(
        screen.getByTestId("chat-widget-discord-recent-connect"),
      ).toBeTruthy(),
    );
  });

  it("applies the provided span class to the root grid item", async () => {
    listConnectorAccountsMock.mockResolvedValue(noAccounts());
    const { container } = render(
      <DiscordRecentWidget spanClassName="col-span-2 row-span-1" />,
    );
    await screen.findByTestId("chat-widget-discord-recent-connect");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("col-span-2");
    expect(root.className).toContain("row-span-1");
  });
});
