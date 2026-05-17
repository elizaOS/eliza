import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useApp } from "../../state";
import { Button } from "../ui/button";

type ConnectorPairingStatus =
  | "idle"
  | "disconnected"
  | "initializing"
  | "waiting_for_qr"
  | "connected"
  | "timeout"
  | "error"
  | string;

interface ConnectorQrPairingOverlayProps {
  connectorName: string;
  status: ConnectorPairingStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  error: string | null;
  onStartPairing: () => void | Promise<void>;
  onStopPairing: () => void | Promise<void>;
  onDisconnect: () => void | Promise<void>;
  onConnected?: () => void;
  connectedMessage?: string;
  connectedPhonePrefix?: string;
  idleDescription: string;
  idleDetail?: string;
  connectLabel: string;
  tryAgainLabel: string;
  timeoutMessage: string;
  defaultErrorMessage: string;
  qrAlt: string;
  qrSizeClassName?: string;
  generatingLabel: string;
  scanTitle: string;
  steps: Array<{ id: string; content: ReactNode }>;
  footer?: ReactNode;
}

export function ConnectorQrPairingOverlay({
  connectorName,
  status,
  qrDataUrl,
  phoneNumber,
  error,
  onStartPairing,
  onStopPairing,
  onDisconnect,
  onConnected,
  connectedMessage,
  connectedPhonePrefix = "",
  idleDescription,
  idleDetail,
  connectLabel,
  tryAgainLabel,
  timeoutMessage,
  defaultErrorMessage,
  qrAlt,
  qrSizeClassName = "h-40 w-40 bg-white dark:bg-white sm:h-48 sm:w-48",
  generatingLabel,
  scanTitle,
  steps,
  footer,
}: ConnectorQrPairingOverlayProps) {
  const { t } = useApp();
  const firedRef = useRef(false);

  useEffect(() => {
    if (status !== "connected") {
      firedRef.current = false;
      return;
    }
    if (!onConnected || firedRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      firedRef.current = true;
      onConnected();
    }, 1200);
    return () => clearTimeout(timer);
  }, [onConnected, status]);

  const start = () => {
    firedRef.current = false;
    void onStartPairing();
  };

  if (status === "connected") {
    return (
      <div className="mt-3 border border-ok bg-[var(--ok-subtle)] p-4">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-ok" />
          <span className="text-xs font-medium text-ok">
            {t("common.connected")}
            {phoneNumber ? ` (${connectedPhonePrefix}${phoneNumber})` : ""}
          </span>
        </div>
        <div className="mt-1 text-2xs text-muted">
          {connectedMessage ??
            (onConnected
              ? `Finishing ${connectorName} setup...`
              : `${connectorName} is paired. Auth state is saved for automatic reconnection.`)}
        </div>
        {!onConnected ? (
          <Button
            variant="destructive"
            size="sm"
            className="mt-2 text-2xs"
            onClick={() => void onDisconnect()}
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
            ? timeoutMessage
            : (error ?? defaultErrorMessage)}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-xs-tight"
          style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
          onClick={start}
        >
          {tryAgainLabel}
        </Button>
      </div>
    );
  }

  if (status === "idle" || status === "disconnected") {
    return (
      <div className="mt-3 border border-border bg-bg-hover p-4">
        <div className="mb-2 text-xs text-muted">{idleDescription}</div>
        {idleDetail ? (
          <div className="mb-2 text-2xs text-muted opacity-70">
            {idleDetail}
          </div>
        ) : null}
        {error ? <div className="mb-2 text-xs text-danger">{error}</div> : null}
        <Button
          variant="outline"
          size="sm"
          className="text-xs-tight"
          style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
          onClick={start}
        >
          {connectLabel}
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
              alt={qrAlt}
              className={qrSizeClassName}
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
                {generatingLabel}
              </span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 text-xs font-medium text-txt">{scanTitle}</div>
          <ol className="m-0 list-decimal space-y-1 pl-4 text-xs-tight text-muted">
            {steps.map((step) => (
              <li key={step.id}>{step.content}</li>
            ))}
          </ol>
          {footer}
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 text-2xs text-muted"
            onClick={() => void onStopPairing()}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
