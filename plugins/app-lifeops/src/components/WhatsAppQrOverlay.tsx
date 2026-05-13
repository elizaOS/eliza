import { Button, useApp } from "@elizaos/ui";
import { useEffect, useRef } from "react";
import { useWhatsAppPairing } from "../hooks/useWhatsAppPairing.js";

interface WhatsAppQrOverlayProps {
  accountId?: string;
  onConnected?: () => void;
  connectedMessage?: string;
}

export function WhatsAppQrOverlay({
  accountId = "default",
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
  const firedRef = useRef(false);

  useEffect(() => {
    if (status !== "connected" || !onConnected || firedRef.current) {
      return;
    }
    firedRef.current = true;
    const timer = setTimeout(onConnected, 1200);
    return () => clearTimeout(timer);
  }, [status, onConnected]);

  if (status === "connected") {
    return (
      <div className="mt-3 border border-ok bg-[var(--ok-subtle)] p-4">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-ok" />
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
        {!onConnected ? (
          <Button
            variant="destructive"
            size="sm"
            className="mt-2 text-2xs"
            onClick={() => void disconnect()}
          >
            {t("common.disconnect")}
          </Button>
        ) : null}
      </div>
    );
  }

  if (status === "error" || status === "timeout") {
    return (
      <div className="mt-3 border border-danger bg-[var(--destructive-subtle)] p-4">
        <div className="mb-2 text-xs text-danger">
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

  if (status === "idle" || status === "disconnected") {
    return (
      <div className="mt-3 border border-border bg-bg-hover p-4">
        <div className="mb-2 text-xs text-muted">
          {t("whatsappqroverlay.ScanAQRCodeWith")}
        </div>
        <div className="text-2xs mb-2 text-muted opacity-70">
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

  return (
    <div
      className="mt-3 p-4"
      style={{
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.04)",
      }}
    >
      <div className="flex flex-col items-start gap-4 sm:flex-row">
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
              <span className="animate-pulse text-xs text-muted">
                {t("whatsappqroverlay.GeneratingQR")}
              </span>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 text-xs font-medium text-txt">
            {t("whatsappqroverlay.ScanWithWhatsApp")}
          </div>
          <ol className="text-xs-tight m-0 list-decimal space-y-1 pl-4 text-muted">
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
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
              style={{ background: "var(--accent)" }}
            />
            <span className="text-2xs text-muted">
              {t("whatsappqroverlay.QRRefreshesAutomat")}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-2xs mt-3 text-muted"
            onClick={() => void stopPairing()}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
