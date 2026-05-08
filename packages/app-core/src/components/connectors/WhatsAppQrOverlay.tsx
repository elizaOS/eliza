import { Button } from "@elizaos/ui";
import { useEffect, useRef } from "react";
import { useWhatsAppPairing } from "../../hooks";
import { DEFAULT_CONNECTOR_ACCOUNT_ID } from "../../hooks/useConnectorAccounts";
import { useApp } from "../../state";

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
  const {
    status,
    qrDataUrl,
    phoneNumber,
    error,
    startPairing,
    stopPairing,
    disconnect,
  } = useWhatsAppPairing(accountId);
  const { t } = useApp();

  // Fire onConnected once when status transitions to "connected"
  const firedRef = useRef(false);
  useEffect(() => {
    if (status === "connected" && onConnected && !firedRef.current) {
      firedRef.current = true;
      // Small delay so the user sees the success state briefly
      const timer = setTimeout(onConnected, 1200);
      return () => clearTimeout(timer);
    }
  }, [status, onConnected]);

  // ── Connected ────────────────────────────────────────────────────────
  if (status === "connected") {
    return (
      <div className="p-4 mt-3 border border-ok bg-[var(--ok-subtle)]">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-ok" />
          <span className="text-xs font-medium text-ok">
            {t("common.connected")}
            {phoneNumber ? ` (+${phoneNumber})` : ""}
          </span>
        </div>
        <div className="text-2xs mt-1 text-muted">
          {connectedMessage ??
            (onConnected
              ? "Finishing WhatsApp setup..."
              : "WhatsApp is paired. Auth state is saved for automatic reconnection.")}
        </div>
        {!onConnected && (
          <Button
            variant="destructive"
            size="sm"
            className="mt-2 text-2xs"
            onClick={() => void disconnect()}
          >
            {t("common.disconnect")}
          </Button>
        )}
      </div>
    );
  }

  // ── Error / Timeout ──────────────────────────────────────────────────
  if (status === "error" || status === "timeout") {
    return (
      <div className="p-4 mt-3 border border-danger bg-[var(--destructive-subtle)]">
        <div className="text-xs mb-2 text-danger">
          {status === "timeout"
            ? "QR code expired. Please try again."
            : (error ?? "An error occurred.")}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-xs-tight"
          style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
          onClick={() => {
            firedRef.current = false;
            void startPairing();
          }}
        >
          {t("whatsappqroverlay.TryAgain")}
        </Button>
      </div>
    );
  }

  // ── Idle ──────────────────────────────────────────────────────────────
  if (status === "idle" || status === "disconnected") {
    return (
      <div className="p-4 mt-3 border border-border bg-bg-hover">
        <div className="text-xs mb-2 text-muted">
          {t("whatsappqroverlay.ScanAQRCodeWith")}
        </div>
        <div className="text-2xs mb-2 opacity-70 text-muted">
          {t("whatsappqroverlay.UsesAnUnofficialW")}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-xs-tight"
          style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
          onClick={() => {
            firedRef.current = false;
            void startPairing();
          }}
        >
          {t("whatsappqroverlay.ConnectWhatsApp")}
        </Button>
      </div>
    );
  }

  // ── Initializing / Waiting for QR ────────────────────────────────────
  return (
    <div
      className="p-4 mt-3"
      style={{
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.04)",
      }}
    >
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        {/* QR Code area */}
        <div className="shrink-0">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="WhatsApp QR Code"
              className="h-40 w-40 bg-white dark:bg-white sm:h-48 sm:w-48"
              style={{
                imageRendering: "pixelated",
                border: "1px solid var(--border)",
              }}
            />
          ) : (
            <div
              className="flex h-40 w-40 items-center justify-center sm:h-48 sm:w-48"
              style={{
                border: "1px solid var(--border)",
                background: "var(--bg-hover)",
              }}
            >
              <span className="text-xs animate-pulse text-muted">
                {t("whatsappqroverlay.GeneratingQR")}
              </span>
            </div>
          )}
        </div>

        {/* Instructions */}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium mb-2 text-txt">
            {t("whatsappqroverlay.ScanWithWhatsApp")}
          </div>
          <ol className="text-xs-tight space-y-1 list-decimal pl-4 m-0 text-muted">
            <li>{t("whatsappqroverlay.OpenWhatsAppOnYou")}</li>
            <li>
              {t("whatsappqroverlay.Tap")}{" "}
              <strong>{t("whatsappqroverlay.Menu")}</strong> or{" "}
              <strong>{t("nav.settings")}</strong>{" "}
              {t("whatsappqroverlay.andSelect")}{" "}
              <strong>{t("whatsappqroverlay.LinkedDevices")}</strong>
            </li>
            <li>
              {t("whatsappqroverlay.Tap")}{" "}
              <strong>{t("whatsappqroverlay.LinkADevice")}</strong>
            </li>
            <li>{t("whatsappqroverlay.PointYourPhoneAt")}</li>
          </ol>
          <div className="mt-3 flex items-center gap-2">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ background: "var(--accent)" }}
            />
            <span className="text-2xs text-muted">
              {t("whatsappqroverlay.QRRefreshesAutomat")}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 text-2xs text-muted"
            onClick={() => void stopPairing()}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
