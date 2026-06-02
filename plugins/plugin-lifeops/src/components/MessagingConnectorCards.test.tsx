// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscordConnectorCard,
  SignalConnectorCard,
  TelegramConnectorCard,
  WhatsAppConnectorCard,
} from "./MessagingConnectorCards.js";

vi.mock(
  "react",
  async () =>
    await import(
      "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
    ),
);

const {
  dispatchFocusConnector,
  refreshDiscord,
  refreshSignal,
  refreshTelegram,
  refreshWhatsApp,
  setActionNotice,
  setTab,
} = vi.hoisted(() => ({
  dispatchFocusConnector: vi.fn(),
  refreshDiscord: vi.fn(),
  refreshSignal: vi.fn(),
  refreshTelegram: vi.fn(),
  refreshWhatsApp: vi.fn(),
  setActionNotice: vi.fn(),
  setTab: vi.fn(),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: vi.fn(), agentProps: {} }),
}));

vi.mock("@elizaos/ui", async () => {
  const React = await import(
    "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
  );
  return {
    Button: React.forwardRef<
      HTMLButtonElement,
      React.ButtonHTMLAttributes<HTMLButtonElement> & {
        size?: string;
        variant?: string;
      }
    >(function Button({ size: _size, variant: _variant, ...props }, ref) {
      return <button ref={ref} {...props} />;
    }),
    client: {},
    dispatchFocusConnector,
    isElectrobunRuntime: () => false,
    openExternalUrl: vi.fn(),
    useAgentElement: () => ({ ref: vi.fn(), agentProps: {} }),
    useApp: () => ({
      setActionNotice,
      setTab,
      t: (_key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? "",
    }),
  };
});

vi.mock("../hooks/useTelegramConnector.js", () => ({
  useTelegramConnector: () => ({
    error: null,
    loading: false,
    pluginManaged: true,
    pluginManagedMessage:
      "Telegram setup is managed by @elizaos/plugin-telegram.",
    refresh: refreshTelegram,
    setupManagedByPlugin: true,
    status: {
      connected: false,
      grantedCapabilities: [],
      identity: null,
    },
  }),
}));

vi.mock("../hooks/useSignalConnector.js", () => ({
  useSignalConnector: () => ({
    error: null,
    loading: false,
    pluginManaged: true,
    pluginManagedMessage: "Signal setup is managed by @elizaos/plugin-signal.",
    refresh: refreshSignal,
    setupManagedByPlugin: true,
    status: {
      connected: false,
      grantedCapabilities: [],
      identity: null,
      inbound: false,
    },
  }),
}));

vi.mock("../hooks/useWhatsAppConnector.js", () => ({
  useWhatsAppConnector: () => ({
    error: null,
    loading: false,
    refresh: refreshWhatsApp,
    status: {
      connected: false,
      degradations: [],
      inboundReady: false,
      outboundReady: false,
      serviceConnected: false,
      transport: "cloudapi",
    },
  }),
}));

vi.mock("../hooks/useDiscordConnector.js", () => ({
  useDiscordConnector: () => ({
    error: null,
    loading: false,
    refresh: refreshDiscord,
    status: {
      available: false,
      browserAccess: [],
      connected: false,
      dmInbox: { count: 0, previews: [], visible: false },
      identity: null,
      reason: "not_configured",
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TelegramConnectorCard", () => {
  it("keeps Telegram setup in connector settings and only refreshes status", () => {
    render(<TelegramConnectorCard />);

    expect(screen.getByLabelText("Managed in Connectors")).toBeTruthy();
    expect(screen.queryByLabelText("Telegram phone number")).toBeNull();
    expect(screen.queryByLabelText("Telegram verification code")).toBeNull();
    expect(screen.queryByLabelText("Telegram 2FA password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open in Connectors: Telegram" }),
    );
    expect(setTab).toHaveBeenCalledWith("connectors");
    expect(dispatchFocusConnector).toHaveBeenCalledWith("telegram");
    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Telegram setup is managed in Connectors"),
      "info",
      4200,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refreshTelegram).toHaveBeenCalledTimes(1);
  });
});

describe("SignalConnectorCard", () => {
  it("keeps Signal setup in connector settings and only refreshes status", () => {
    render(<SignalConnectorCard />);

    expect(screen.getByLabelText("Managed in Connectors")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link Signal" })).toBeNull();
    expect(screen.queryByAltText("Signal pairing QR code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open in Connectors: Signal" }),
    );
    expect(setTab).toHaveBeenCalledWith("connectors");
    expect(dispatchFocusConnector).toHaveBeenCalledWith("signal");
    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Signal setup is managed in Connectors"),
      "info",
      4200,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refreshSignal).toHaveBeenCalledTimes(1);
  });
});

describe("WhatsAppConnectorCard", () => {
  it("keeps WhatsApp setup in connector settings and only refreshes status", () => {
    render(<WhatsAppConnectorCard />);

    expect(screen.getByLabelText("Managed in Connectors")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pair WhatsApp" })).toBeNull();
    expect(screen.queryByAltText("WhatsApp QR Code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide WhatsApp QR" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open in Connectors: WhatsApp" }),
    );
    expect(setTab).toHaveBeenCalledWith("connectors");
    expect(dispatchFocusConnector).toHaveBeenCalledWith("whatsapp");
    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("WhatsApp setup is managed in Connectors"),
      "info",
      4200,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refreshWhatsApp).toHaveBeenCalledTimes(1);
  });
});

describe("DiscordConnectorCard", () => {
  it("keeps Discord setup in connector settings and only refreshes status", () => {
    render(<DiscordConnectorCard />);

    expect(screen.getByLabelText("Browser access unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Discord" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Open Discord in Eliza Desktop Browser",
      }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Open in Connectors: Discord" }),
    );
    expect(setTab).toHaveBeenCalledWith("connectors");
    expect(dispatchFocusConnector).toHaveBeenCalledWith("discord");
    expect(setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Discord setup is managed in Connectors"),
      "info",
      4200,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refreshDiscord).toHaveBeenCalledTimes(1);
  });
});
