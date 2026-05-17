import type { ReactNode } from "react";

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
  steps: Array<{
    id: string;
    content: ReactNode;
  }>;
  footer?: ReactNode;
}
export declare function ConnectorQrPairingOverlay({
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
  connectedPhonePrefix,
  idleDescription,
  idleDetail,
  connectLabel,
  tryAgainLabel,
  timeoutMessage,
  defaultErrorMessage,
  qrAlt,
  qrSizeClassName,
  generatingLabel,
  scanTitle,
  steps,
  footer,
}: ConnectorQrPairingOverlayProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ConnectorQrPairingOverlay.d.ts.map
