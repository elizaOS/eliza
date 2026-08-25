/**
 * Verifies the shared WhatsApp QR pairing surface uses the connector
 * detail action-row contract in deterministic idle and connected states.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: { t: (key: string) => string }) => unknown,
  ) => selector({ t: (key) => key }),
}));

import { ConnectorQrPairingOverlay } from "./ConnectorQrPairingOverlay";

const baseProps = {
  connectorName: "WhatsApp",
  qrDataUrl: null,
  phoneNumber: null,
  error: null,
  onStartPairing: vi.fn(),
  onStopPairing: vi.fn(),
  onDisconnect: vi.fn(),
  idleDescription: "Pair WhatsApp from your phone.",
  connectLabel: "Connect WhatsApp",
  tryAgainLabel: "Try again",
  timeoutMessage: "Pairing timed out.",
  defaultErrorMessage: "Pairing failed.",
  qrAlt: "WhatsApp QR code",
  generatingLabel: "Generating QR…",
  scanTitle: "Scan with WhatsApp",
  steps: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConnectorQrPairingOverlay", () => {
  it("renders idle copy on the left and the primary connect action on the right", () => {
    render(<ConnectorQrPairingOverlay {...baseProps} status="idle" />);

    const button = screen.getByRole("button", { name: "Connect WhatsApp" });
    const actionRail = button.parentElement;

    expect(button.className).toContain("bg-accent");
    expect(actionRail?.previousElementSibling?.textContent).toContain(
      "Pair WhatsApp from your phone.",
    );

    fireEvent.click(button);
    expect(baseProps.onStartPairing).toHaveBeenCalledOnce();
  });

  it("keeps disconnect as the trailing action after pairing", () => {
    render(
      <ConnectorQrPairingOverlay
        {...baseProps}
        status="connected"
        phoneNumber="5550100"
      />,
    );

    const button = screen.getByRole("button", { name: "common.disconnect" });
    expect(button.parentElement?.previousElementSibling?.textContent).toContain(
      "common.connected (5550100)",
    );

    fireEvent.click(button);
    expect(baseProps.onDisconnect).toHaveBeenCalledOnce();
  });
});
