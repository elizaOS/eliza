// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getConnectorsMock, listConnectorAccountsMock } = vi.hoisted(() => ({
  getConnectorsMock: vi.fn(),
  listConnectorAccountsMock: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: {
    getConnectors: getConnectorsMock,
    listConnectorAccounts: listConnectorAccountsMock,
  },
}));

// useWidgetNavigation → reportUserViewSwitch; stub so the click test isolates
// the navigation rail (the eliza:navigate:view CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

import type { WidgetProps } from "../../../widgets/types";
import { ConnectorsStatusWidget } from "./connectors-status";

const homeProps: Partial<WidgetProps> = {
  slot: "home",
  spanClassName: "col-span-4 row-span-1",
};

const ALL_CONNECTORS = {
  connectors: { google: {}, discord: {}, telegram: {} },
};

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    provider: "google",
    connectorId: "google",
    label: "Account",
    ...overrides,
  };
}

function mockAccountsByProvider(
  byProvider: Record<string, Record<string, unknown>[]>,
) {
  listConnectorAccountsMock.mockImplementation(async (provider: string) => ({
    provider,
    connectorId: provider,
    accounts: byProvider[provider] ?? [],
  }));
}

afterEach(() => {
  cleanup();
  getConnectorsMock.mockReset();
  listConnectorAccountsMock.mockReset();
});

describe("ConnectorsStatusWidget (#9143)", () => {
  it("shows a loading state before data resolves", () => {
    getConnectorsMock.mockReturnValue(new Promise(() => {}));
    listConnectorAccountsMock.mockReturnValue(new Promise(() => {}));
    render(<ConnectorsStatusWidget {...homeProps} />);
    expect(screen.getByTestId("connectors-status-loading")).toBeTruthy();
  });

  it("renders connected chips with the handle/label when all are connected", async () => {
    getConnectorsMock.mockResolvedValue(ALL_CONNECTORS);
    mockAccountsByProvider({
      google: [account({ status: "connected", handle: "me@example.com" })],
      discord: [account({ status: "connected", label: "guildbot" })],
      telegram: [account({ status: "connected", handle: "@tg" })],
    });
    render(<ConnectorsStatusWidget {...homeProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("connectors-chip-google")).toBeTruthy();
    });
    expect(
      screen.getByTestId("connectors-chip-google").getAttribute("data-state"),
    ).toBe("connected");
    expect(
      screen.getByTestId("connectors-chip-google").getAttribute("aria-label"),
    ).toMatch(/me@example.com/);
    expect(
      screen.getByTestId("connectors-chip-discord").getAttribute("data-state"),
    ).toBe("connected");
    expect(
      screen.getByTestId("connectors-chip-telegram").getAttribute("data-state"),
    ).toBe("connected");
  });

  it("renders a partial mix: connected + connect prompts", async () => {
    getConnectorsMock.mockResolvedValue(ALL_CONNECTORS);
    mockAccountsByProvider({
      google: [account({ status: "connected", handle: "me@example.com" })],
      discord: [],
      telegram: [],
    });
    render(<ConnectorsStatusWidget {...homeProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("connectors-chip-google")).toBeTruthy();
    });
    expect(
      screen.getByTestId("connectors-chip-google").getAttribute("data-state"),
    ).toBe("connected");
    expect(
      screen.getByTestId("connectors-chip-discord").getAttribute("data-state"),
    ).toBe("connect");
    expect(screen.getByTestId("connectors-chip-telegram").textContent).toMatch(
      /Connect Telegram/,
    );
  });

  it("renders connect prompts for every provider on a fresh device", async () => {
    getConnectorsMock.mockResolvedValue(ALL_CONNECTORS);
    mockAccountsByProvider({ google: [], discord: [], telegram: [] });
    render(<ConnectorsStatusWidget {...homeProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("connectors-chip-google")).toBeTruthy();
    });
    for (const provider of ["google", "discord", "telegram"]) {
      expect(
        screen
          .getByTestId(`connectors-chip-${provider}`)
          .getAttribute("data-state"),
      ).toBe("connect");
    }
  });

  it("renders a warn chip for an error / needs-reauth account", async () => {
    getConnectorsMock.mockResolvedValue(ALL_CONNECTORS);
    mockAccountsByProvider({
      google: [account({ status: "error", label: "Token expired" })],
      discord: [account({ status: "needs-reauth", label: "Reauth" })],
      telegram: [account({ status: "connected", handle: "@tg" })],
    });
    render(<ConnectorsStatusWidget {...homeProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("connectors-chip-google")).toBeTruthy();
    });
    expect(
      screen.getByTestId("connectors-chip-google").getAttribute("data-state"),
    ).toBe("warn");
    expect(
      screen.getByTestId("connectors-chip-discord").getAttribute("data-state"),
    ).toBe("warn");
  });

  it("opens the connectors settings view when a chip is clicked", async () => {
    getConnectorsMock.mockResolvedValue(ALL_CONNECTORS);
    mockAccountsByProvider({ google: [], discord: [], telegram: [] });
    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<ConnectorsStatusWidget {...homeProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("connectors-chip-google")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("connectors-chip-google"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/settings/connectors");
  });

  it("applies the received spanClassName to its single root element", async () => {
    getConnectorsMock.mockResolvedValue(ALL_CONNECTORS);
    mockAccountsByProvider({ google: [], discord: [], telegram: [] });
    render(<ConnectorsStatusWidget {...homeProps} />);

    const root = screen.getByTestId("chat-widget-connectors-status");
    expect(root.className).toContain("col-span-4");
    expect(root.className).toContain("row-span-1");
  });

  it("still renders connect prompts when getConnectors fails (fallback set)", async () => {
    getConnectorsMock.mockRejectedValue(new Error("boom"));
    mockAccountsByProvider({ google: [], discord: [], telegram: [] });
    render(<ConnectorsStatusWidget {...homeProps} />);

    await waitFor(() => {
      expect(screen.getByTestId("connectors-chip-google")).toBeTruthy();
    });
    expect(screen.getByTestId("connectors-chip-discord")).toBeTruthy();
    expect(screen.getByTestId("connectors-chip-telegram")).toBeTruthy();
  });
});
