import { useMemo } from "react";
import { useSignalPairing } from "../../hooks";
import { DEFAULT_CONNECTOR_ACCOUNT_ID } from "../../hooks/useConnectorAccounts";
import { useApp } from "../../state";
import { ConnectorQrPairingOverlay } from "./ConnectorQrPairingOverlay";

interface SignalQrOverlayProps {
  accountId?: string;
  onConnected?: () => void;
}

export function SignalQrOverlay({
  accountId = DEFAULT_CONNECTOR_ACCOUNT_ID,
  onConnected,
}: SignalQrOverlayProps) {
  const pairing = useSignalPairing(accountId);
  const { t } = useApp();
  const steps = useMemo(
    () => [
      {
        id: "open-desktop",
        content: t("signalqroverlay.OpenSignalDesktop", {
          defaultValue: "Open Signal Desktop on your Mac.",
        }),
      },
      {
        id: "open-linked-devices",
        content: t("signalqroverlay.OpenLinkedDevices", {
          defaultValue: "Open Signal settings and choose Linked Devices.",
        }),
      },
      {
        id: "scan-prompt",
        content: t("signalqroverlay.ScanPrompt", {
          defaultValue:
            "Choose Link New Device and scan the QR code shown here.",
        }),
      },
    ],
    [t],
  );

  return (
    <ConnectorQrPairingOverlay
      connectorName="Signal"
      status={pairing.status}
      qrDataUrl={pairing.qrDataUrl}
      phoneNumber={pairing.phoneNumber}
      error={pairing.error}
      onStartPairing={pairing.startPairing}
      onStopPairing={pairing.stopPairing}
      onDisconnect={pairing.disconnect}
      onConnected={onConnected}
      idleDescription={t("signalqroverlay.PairUsingSignalDesktop", {
        defaultValue:
          "Pair Signal by generating a provisioning QR code and scanning it from Signal Desktop.",
      })}
      connectLabel={t("signalqroverlay.ConnectSignal", {
        defaultValue: "Connect Signal",
      })}
      tryAgainLabel={t("signalqroverlay.TryAgain", {
        defaultValue: "Try again",
      })}
      timeoutMessage="Signal pairing timed out. Start a new session and scan again."
      defaultErrorMessage="Signal pairing failed."
      qrAlt="Signal QR Code"
      qrSizeClassName="h-48 w-48 bg-white dark:bg-white"
      generatingLabel={t("signalqroverlay.GeneratingQR", {
        defaultValue: "Generating QR...",
      })}
      scanTitle={t("signalqroverlay.ScanWithSignalDesktop", {
        defaultValue: "Scan with Signal Desktop",
      })}
      steps={steps}
    />
  );
}
