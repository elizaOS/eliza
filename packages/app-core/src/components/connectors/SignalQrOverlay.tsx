import { Button } from "@elizaos/ui";
import { useEffect, useRef } from "react";
import { useSignalPairing } from "../../hooks";
import { DEFAULT_CONNECTOR_ACCOUNT_ID } from "../../hooks/useConnectorAccounts";
import { useApp } from "../../state";

interface SignalQrOverlayProps {
  accountId?: string;
  onConnected?: () => void;
}

export function SignalQrOverlay({
  accountId = DEFAULT_CONNECTOR_ACCOUNT_ID,
  onConnected,
}: SignalQrOverlayProps) {
  const {
    status,
    qrDataUrl,
    phoneNumber,
    error,
    startPairing,
    stopPairing,
    disconnect,
  } = useSignalPairing(accountId);
  const { t } = useApp();
  const firedRef = useRef(false);

  useEffect(() => {
    if (status !== "connected" || !onConnected || firedRef.current) {
      return;
    }
    firedRef.current = true;
    const timer = setTimeout(onConnected, 1200);
    return () => clearTimeout(timer);
  }, [onConnected, status]);

  if (status === "connected") {
    return (
      <div className="mt-3 p-4 border border-ok bg-[var(--ok-subtle)]">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-ok" />
          <span className="text-xs font-medium text-ok">
            {t("common.connected")}
            {phoneNumber ? ` (${phoneNumber})` : ""}
          </span>
        </div>
        <div className="mt-1 text-2xs text-muted">
          {onConnected
            ? "Finishing Signal setup..."
            : "Signal is paired. Auth state is saved for automatic reconnection."}
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
      <div className="mt-3 p-4 border border-danger bg-[var(--destructive-subtle)]">
        <div className="mb-2 text-xs text-danger">
          {status === "timeout"
            ? "Signal pairing timed out. Start a new session and scan again."
            : (error ?? "Signal pairing failed.")}
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
          {t("whatsappqroverlay.TryAgain", {
            defaultValue: "Try again",
          })}
        </Button>
      </div>
    );
  }

  if (status === "idle" || status === "disconnected") {
    return (
      <div className="mt-3 p-4 border border-border bg-bg-hover">
        <div className="mb-2 text-xs text-muted">
          {t("signalqroverlay.PairUsingSignalDesktop", {
            defaultValue:
              "Pair Signal by generating a provisioning QR code and scanning it from Signal Desktop.",
          })}
        </div>
        {error ? <div className="mb-2 text-xs text-danger">{error}</div> : null}
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
          {t("signalqroverlay.ConnectSignal", {
            defaultValue: "Connect Signal",
          })}
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
      <div className="flex items-start gap-4">
        <div className="shrink-0">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="Signal QR Code"
              className="h-48 w-48 bg-white dark:bg-white"
              style={{
                imageRendering: "pixelated",
                border: "1px solid var(--border)",
              }}
            />
          ) : (
            <div
              className="flex h-48 w-48 items-center justify-center"
              style={{
                border: "1px solid var(--border)",
                background: "var(--bg-hover)",
              }}
            >
              <span className="animate-pulse text-xs text-muted">
                {t("signalqroverlay.GeneratingQR", {
                  defaultValue: "Generating QR…",
                })}
              </span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 text-xs font-medium text-txt">
            {t("signalqroverlay.ScanWithSignalDesktop", {
              defaultValue: "Scan with Signal Desktop",
            })}
          </div>
          <ol className="m-0 list-decimal space-y-1 pl-4 text-xs-tight text-muted">
            <li>
              {t("signalqroverlay.OpenSignalDesktop", {
                defaultValue: "Open Signal Desktop on your Mac.",
              })}
            </li>
            <li>
              {t("signalqroverlay.OpenLinkedDevices", {
                defaultValue: "Open Signal settings and choose Linked Devices.",
              })}
            </li>
            <li>
              {t("signalqroverlay.ScanPrompt", {
                defaultValue:
                  "Choose Link New Device and scan the QR code shown here.",
              })}
            </li>
          </ol>
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
