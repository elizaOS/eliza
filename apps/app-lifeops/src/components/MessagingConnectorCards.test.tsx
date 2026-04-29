// @vitest-environment jsdom

import type {
  LifeOpsDiscordConnectorStatus,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalPairingStatus,
  LifeOpsWhatsAppConnectorStatus,
} from "@elizaos/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  discordConnectorState,
  setActionNoticeMock,
  setTabMock,
  signalConnectorState,
  whatsappConnectorState,
} = vi.hoisted(() => ({
  discordConnectorState: {
    status: null as LifeOpsDiscordConnectorStatus | null,
    loading: false,
    actionPending: false,
    error: null as string | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
  },
  setActionNoticeMock: vi.fn(),
  setTabMock: vi.fn(),
  signalConnectorState: {
    status: null as LifeOpsSignalConnectorStatus | null,
    loading: false,
    actionPending: false,
    error: null as string | null,
    pairingStatus: null as LifeOpsSignalPairingStatus | null,
    startPairing: vi.fn(),
    stopPairing: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
  },
  whatsappConnectorState: {
    status: null as LifeOpsWhatsAppConnectorStatus | null,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core", () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    size?: string;
    variant?: string;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  client: {
    startDiscordConnector: vi.fn(),
  },
  isElectrobunRuntime: () => false,
  openExternalUrl: vi.fn(),
  useApp: () => ({
    setActionNotice: setActionNoticeMock,
    setTab: setTabMock,
  }),
}));

vi.mock("../hooks/useDiscordConnector.js", () => ({
  useDiscordConnector: () => discordConnectorState,
}));

vi.mock("../hooks/useIMessageConnector.js", () => ({
  useIMessageConnector: () => ({
    status: null,
    loading: false,
    error: null,
    fullDiskAccess: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("../hooks/useSignalConnector.js", () => ({
  useSignalConnector: () => signalConnectorState,
}));

vi.mock("../hooks/useTelegramConnector.js", () => ({
  useTelegramConnector: () => ({
    status: null,
    loading: false,
    actionPending: false,
    verifyPending: false,
    error: null,
    authState: "idle",
    verification: null,
    startAuth: vi.fn(),
    submitCode: vi.fn(),
    submitPassword: vi.fn(),
    cancelAuth: vi.fn(),
    disconnect: vi.fn(),
    verify: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("../hooks/useWhatsAppConnector.js", () => ({
  useWhatsAppConnector: () => whatsappConnectorState,
}));

vi.mock("./WhatsAppQrOverlay.js", () => ({
  WhatsAppQrOverlay: () => <div data-testid="whatsapp-qr" />,
}));

import {
  DiscordConnectorCard,
  SignalConnectorCard,
  WhatsAppConnectorCard,
} from "./MessagingConnectorCards.js";

function discordStatus(
  overrides: Partial<LifeOpsDiscordConnectorStatus> = {},
): LifeOpsDiscordConnectorStatus {
  return {
    provider: "discord",
    side: "owner",
    available: false,
    connected: false,
    reason: "disconnected",
    identity: null,
    dmInbox: {
      visible: false,
      count: 0,
      selectedChannelId: null,
      previews: [],
    },
    grantedCapabilities: [],
    lastError: null,
    tabId: null,
    browserAccess: [],
    grant: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  discordConnectorState.status = null;
  discordConnectorState.loading = false;
  discordConnectorState.actionPending = false;
  discordConnectorState.error = null;
  signalConnectorState.status = null;
  signalConnectorState.loading = false;
  signalConnectorState.actionPending = false;
  signalConnectorState.error = null;
  signalConnectorState.pairingStatus = null;
  whatsappConnectorState.status = null;
  whatsappConnectorState.loading = false;
  whatsappConnectorState.error = null;
});

describe("MessagingConnectorCards", () => {
  it("shows one-way WhatsApp readiness instead of treating connected as fully ready", () => {
    whatsappConnectorState.status = {
      provider: "whatsapp",
      connected: true,
      inbound: true,
      inboundReady: true,
      outboundReady: false,
      serviceConnected: false,
      transport: "cloudapi",
      lastCheckedAt: "2026-04-29T12:00:00.000Z",
    };

    render(<WhatsAppConnectorCard />);

    expect(screen.getByRole("img", { name: "Inbound only" })).toBeTruthy();
    expect(screen.getByText("Inbound: ready")).toBeTruthy();
    expect(screen.getByText("Outbound: not ready")).toBeTruthy();
  });

  it("marks connected Signal as degraded when inbound read is not ready", () => {
    signalConnectorState.status = {
      provider: "signal",
      side: "owner",
      connected: true,
      inbound: false,
      reason: "connected",
      identity: { phoneNumber: "+15551234567" },
      grantedCapabilities: ["signal.send"],
      pairing: null,
      grant: null,
    };

    render(<SignalConnectorCard />);

    expect(
      screen.getByRole("img", { name: "Connected, inbound off" }),
    ).toBeTruthy();
    expect(screen.getByText("Inbound: not ready")).toBeTruthy();
    expect(screen.getByText("Send: ready")).toBeTruthy();
  });

  it("uses the Discord status next action for the primary connect button", async () => {
    discordConnectorState.status = discordStatus({
      browserAccess: [
        {
          source: "lifeops_browser",
          active: false,
          available: false,
          browser: null,
          profileId: null,
          profileLabel: null,
          companionId: null,
          companionLabel: null,
          canControl: false,
          siteAccessOk: null,
          currentUrl: null,
          tabState: "missing",
          authState: "unknown",
          nextAction: "connect_browser",
        },
      ],
    });

    render(<DiscordConnectorCard />);

    const [primaryButton] = screen.getAllByRole("button", {
      name: "Connect Your Browser",
    });
    fireEvent.click(primaryButton);

    await waitFor(() => {
      expect(setTabMock).toHaveBeenCalledWith("browser");
      expect(setActionNoticeMock).toHaveBeenCalledWith(
        expect.stringContaining("Guided Browser Setup"),
        "info",
        4200,
      );
    });
    expect(discordConnectorState.connect).not.toHaveBeenCalled();
  });
});
