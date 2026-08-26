/**
 * Generic QR-code pairing overlay shared by the phone-linking connectors
 * (currently WhatsApp). Given a pairing status, QR data URL, and lifecycle
 * callbacks, it renders the step instructions plus the QR/connected/error
 * states; connector-specific overlays such as `WhatsAppQrOverlay`
 * wrap it with their own pairing hook and copy.
 */

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useAppSelector } from "../../state";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { StatusDot } from "../ui/status-badge";

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
  const t = useAppSelector((s) => s.t);
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
      <PagePanel.Notice
        tone="accent"
        actions={
          !onConnected ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void onDisconnect()}
            >
              {t("common.disconnect")}
            </Button>
          ) : undefined
        }
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-semibold text-ok">
            <StatusDot tone="success" className="size-2" />
            <span>
              {t("common.connected")}
              {phoneNumber ? ` (${connectedPhonePrefix}${phoneNumber})` : ""}
            </span>
          </div>
          <p className="text-xs-tight text-muted">
            {connectedMessage ??
              (onConnected
                ? `Finishing ${connectorName} setup...`
                : `${connectorName} is paired. Auth state is saved for automatic reconnection.`)}
          </p>
        </div>
      </PagePanel.Notice>
    );
  }

  if (status === "error" || status === "timeout") {
    return (
      <PagePanel.Notice
        tone="danger"
        actions={
          <Button variant="default" size="sm" onClick={start}>
            {tryAgainLabel}
          </Button>
        }
      >
        <p className="text-xs-tight">
          {status === "timeout"
            ? timeoutMessage
            : (error ?? defaultErrorMessage)}
        </p>
      </PagePanel.Notice>
    );
  }

  if (status === "idle" || status === "disconnected") {
    return (
      <PagePanel.Notice
        tone={error ? "danger" : "default"}
        actions={
          <Button variant="default" size="sm" onClick={start}>
            {connectLabel}
          </Button>
        }
      >
        <div className="space-y-1">
          <p className="text-xs-tight text-muted">{idleDescription}</p>
          {idleDetail ? (
            <p className="text-2xs text-muted">{idleDetail}</p>
          ) : null}
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      </PagePanel.Notice>
    );
  }

  return (
    <Card variant="panel" padding="comfortable">
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        <div className="shrink-0">
          {qrDataUrl ? (
            <Card
              variant="transparentSquare"
              border="standard"
              surface="transparent"
              className={qrSizeClassName}
            >
              <img
                src={qrDataUrl}
                alt={qrAlt}
                className="h-full w-full"
                style={{ imageRendering: "pixelated" }}
              />
            </Card>
          ) : (
            <Card
              border="standard"
              surface="raised"
              className="flex size-40 items-center justify-center sm:h-48 sm:w-48"
            >
              <span className="animate-pulse text-xs text-muted">
                {generatingLabel}
              </span>
            </Card>
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
            className="mt-3"
            onClick={() => void onStopPairing()}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
