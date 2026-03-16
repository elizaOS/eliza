import { useEffect, useRef } from "react";
import { useWhatsAppPairing } from "../hooks";
import { useApp } from "../state";

interface WhatsAppQrOverlayProps {
  accountId?: string;
  /** Called when QR pairing succeeds — parent should install plugin + close modal. */
  onConnected?: () => void;
}

export function WhatsAppQrOverlay({
  accountId = "default",
  onConnected,
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
      <div
        className="p-4 mt-3"
        style={{
          border: "1px solid #22c55e",
          background: "var(--ok-subtle)",
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: "#22c55e" }}
          />
          <span className="text-xs font-medium" style={{ color: "#22c55e" }}>
            {t("onboarding.connected")}
            {phoneNumber ? ` (+${phoneNumber})` : ""}
          </span>
        </div>
        <div className="text-[10px] mt-1" style={{ color: "var(--muted)" }}>
          {onConnected
            ? "Installing WhatsApp plugin and restarting agent..."
            : "WhatsApp is paired. Auth state is saved for automatic reconnection."}
        </div>
        {!onConnected && (
          <button
            type="button"
            className="mt-2 px-2.5 py-1 text-[10px] bg-transparent cursor-pointer transition-colors"
            style={{ border: "1px solid #ef4444", color: "#ef4444" }}
            onClick={() => void disconnect()}
          >
            {t("whatsappqroverlay.Disconnect")}
          </button>
        )}
      </div>
    );
  }

  // ── Error / Timeout ──────────────────────────────────────────────────
  if (status === "error" || status === "timeout") {
    return (
      <div
        className="p-4 mt-3"
        style={{
          border: "1px solid #ef4444",
          background: "var(--destructive-subtle)",
        }}
      >
        <div className="text-xs mb-2" style={{ color: "#ef4444" }}>
          {status === "timeout"
            ? "QR code expired. Please try again."
            : (error ?? "An error occurred.")}
        </div>
        <button
          type="button"
          className="px-3 py-1.5 text-[11px] bg-transparent cursor-pointer transition-colors"
          style={{ border: "1px solid #f0b232", color: "#f0b232" }}
          onClick={() => {
            firedRef.current = false;
            void startPairing();
          }}
        >
          {t("whatsappqroverlay.TryAgain")}
        </button>
      </div>
    );
  }

  // ── Idle ──────────────────────────────────────────────────────────────
  if (status === "idle" || status === "disconnected") {
    return (
      <div
        className="p-4 mt-3"
        style={{
          border: "1px solid var(--border)",
          background: "var(--bg-hover)",
        }}
      >
        <div className="text-xs mb-2" style={{ color: "var(--muted)" }}>
          {t("whatsappqroverlay.ScanAQRCodeWith")}
        </div>
        <div
          className="text-[10px] mb-2 opacity-70"
          style={{ color: "var(--muted)" }}
        >
          {t("whatsappqroverlay.UsesAnUnofficialW")}
        </div>
        <button
          type="button"
          className="px-3 py-1.5 text-[11px] bg-transparent cursor-pointer transition-colors"
          style={{ border: "1px solid #f0b232", color: "#f0b232" }}
          onClick={() => {
            firedRef.current = false;
            void startPairing();
          }}
        >
          {t("whatsappqroverlay.ConnectWhatsApp")}
        </button>
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
      <div className="flex items-start gap-4">
        {/* QR Code area */}
        <div className="shrink-0">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="WhatsApp QR Code"
              className="w-48 h-48 bg-white"
              style={{
                imageRendering: "pixelated",
                border: "1px solid var(--border)",
              }}
            />
          ) : (
            <div
              className="w-48 h-48 flex items-center justify-center"
              style={{
                border: "1px solid var(--border)",
                background: "var(--bg-hover)",
              }}
            >
              <span
                className="text-xs animate-pulse"
                style={{ color: "var(--muted)" }}
              >
                {t("whatsappqroverlay.GeneratingQR")}
              </span>
            </div>
          )}
        </div>

        {/* Instructions */}
        <div className="flex-1 min-w-0">
          <div
            className="text-xs font-medium mb-2"
            style={{ color: "var(--text)" }}
          >
            {t("whatsappqroverlay.ScanWithWhatsApp")}
          </div>
          <ol
            className="text-[11px] space-y-1 list-decimal pl-4 m-0"
            style={{ color: "var(--muted)" }}
          >
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
              style={{ background: "#f0b232" }}
            />
            <span className="text-[10px]" style={{ color: "var(--muted)" }}>
              {t("whatsappqroverlay.QRRefreshesAutomat")}
            </span>
          </div>
          <button
            type="button"
            className="mt-3 px-2.5 py-1 text-[10px] cursor-pointer transition-colors"
            style={{
              border: "1px solid var(--border)",
              color: "var(--muted)",
            }}
            onClick={() => void stopPairing()}
          >
            {t("onboarding.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
