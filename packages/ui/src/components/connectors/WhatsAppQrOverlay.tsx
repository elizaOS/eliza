import { useMemo } from "react";
import { useWhatsAppPairing } from "../../hooks";
import { DEFAULT_CONNECTOR_ACCOUNT_ID } from "../../hooks/useConnectorAccounts";
import { useApp } from "../../state";
import { ConnectorQrPairingOverlay } from "./ConnectorQrPairingOverlay";

interface WhatsAppQrOverlayProps {
  accountId?: string;
  /** Called when QR pairing succeeds — parent should install plugin + close modal. */
  onConnected?: () => void;
  connectedMessage?: string;
}

export function WhatsAppQrOverlay({
  accountId = DEFAULT_CONNECTOR_ACCOUNT_ID,
  onConnected,
  connectedMessage,
}: WhatsAppQrOverlayProps) {
  const pairing = useWhatsAppPairing(accountId);
  const { t } = useApp();
  const steps = useMemo(
    () => [
      {
        id: "open-app",
        content: t("whatsappqroverlay.OpenWhatsAppOnYou"),
      },
      {
        id: "open-linked-devices",
        content: (
          <>
            {t("whatsappqroverlay.Tap")}{" "}
            <strong>{t("whatsappqroverlay.Menu")}</strong> or{" "}
            <strong>{t("nav.settings")}</strong>{" "}
            {t("whatsappqroverlay.andSelect")}{" "}
            <strong>{t("whatsappqroverlay.LinkedDevices")}</strong>
          </>
        ),
      },
      {
        id: "link-device",
        content: (
          <>
            {t("whatsappqroverlay.Tap")}{" "}
            <strong>{t("whatsappqroverlay.LinkADevice")}</strong>
          </>
        ),
      },
      {
        id: "scan-code",
        content: t("whatsappqroverlay.PointYourPhoneAt"),
      },
    ],
    [t],
  );
  const footer = useMemo(
    () => (
      <div className="mt-3 flex items-center gap-2">
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
          style={{ background: "var(--accent)" }}
        />
        <span className="text-2xs text-muted">
          {t("whatsappqroverlay.QRRefreshesAutomat")}
        </span>
      </div>
    ),
    [t],
  );

  return (
    <ConnectorQrPairingOverlay
      connectorName="WhatsApp"
      status={pairing.status}
      qrDataUrl={pairing.qrDataUrl}
      phoneNumber={pairing.phoneNumber}
      error={pairing.error}
      onStartPairing={pairing.startPairing}
      onStopPairing={pairing.stopPairing}
      onDisconnect={pairing.disconnect}
      onConnected={onConnected}
      connectedMessage={connectedMessage}
      connectedPhonePrefix="+"
      idleDescription={t("whatsappqroverlay.ScanAQRCodeWith")}
      idleDetail={t("whatsappqroverlay.UsesAnUnofficialW")}
      connectLabel={t("whatsappqroverlay.ConnectWhatsApp")}
      tryAgainLabel={t("whatsappqroverlay.TryAgain")}
      timeoutMessage="QR code expired. Please try again."
      defaultErrorMessage="An error occurred."
      qrAlt="WhatsApp QR Code"
      generatingLabel={t("whatsappqroverlay.GeneratingQR")}
      scanTitle={t("whatsappqroverlay.ScanWithWhatsApp")}
      steps={steps}
      footer={footer}
    />
  );
}
