import { client } from "@elizaos/app-core";
import { useCallback, useEffect, useState } from "react";

type WhatsAppPairingStatus =
  | "idle"
  | "initializing"
  | "waiting_for_qr"
  | "connected"
  | "disconnected"
  | "timeout"
  | "error";

interface WhatsAppPairingState {
  status: WhatsAppPairingStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  error: string | null;
}

const WHATSAPP_PAIRING_STATUSES: Record<WhatsAppPairingStatus, true> = {
  idle: true,
  initializing: true,
  waiting_for_qr: true,
  connected: true,
  disconnected: true,
  timeout: true,
  error: true,
};

const LIFEOPS_WHATSAPP_PAIRING_OPTIONS = {
  authScope: "lifeops",
  configurePlugin: false,
} as const;

function isWhatsAppPairingStatus(
  value: unknown,
): value is WhatsAppPairingStatus {
  return typeof value === "string" && value in WHATSAPP_PAIRING_STATUSES;
}

function formatPairingError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useWhatsAppPairing(accountId = "default") {
  const [state, setState] = useState<WhatsAppPairingState>({
    status: "idle",
    qrDataUrl: null,
    phoneNumber: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    void client
      .getWhatsAppStatus(accountId, LIFEOPS_WHATSAPP_PAIRING_OPTIONS)
      .then((response) => {
        if (cancelled) {
          return;
        }
        if (response.status === "connected" && response.serviceConnected) {
          setState((previous) => ({
            ...previous,
            status: "connected",
            phoneNumber: response.servicePhone,
          }));
          return;
        }
        if (response.authExists) {
          setState((previous) => ({
            ...previous,
            status: "disconnected",
            phoneNumber: response.servicePhone,
            error: null,
          }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState((previous) => ({
            ...previous,
            status: "error",
            error: "WhatsApp pairing status failed to load.",
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    const unbindQr = client.onWsEvent("whatsapp-qr", (data) => {
      if (
        data.accountId !== accountId ||
        data.authScope !== "lifeops" ||
        typeof data.qrDataUrl !== "string"
      ) {
        return;
      }
      const qrDataUrl = data.qrDataUrl;
      setState((previous) => ({
        ...previous,
        status: "waiting_for_qr",
        qrDataUrl,
        error: null,
      }));
    });

    const unbindStatus = client.onWsEvent("whatsapp-status", (data) => {
      if (
        data.accountId !== accountId ||
        data.authScope !== "lifeops" ||
        !isWhatsAppPairingStatus(data.status)
      ) {
        return;
      }
      const nextStatus = data.status;
      setState((previous) => ({
        ...previous,
        status: nextStatus,
        phoneNumber:
          typeof data.phoneNumber === "string"
            ? data.phoneNumber
            : previous.phoneNumber,
        error: typeof data.error === "string" ? data.error : null,
        qrDataUrl:
          nextStatus === "connected" ||
          nextStatus === "disconnected" ||
          nextStatus === "timeout" ||
          nextStatus === "error"
            ? null
            : previous.qrDataUrl,
      }));
    });

    return () => {
      unbindQr();
      unbindStatus();
    };
  }, [accountId]);

  const startPairing = useCallback(async () => {
    setState({
      status: "initializing",
      qrDataUrl: null,
      phoneNumber: null,
      error: null,
    });
    try {
      const result = await client.startWhatsAppPairing(
        accountId,
        LIFEOPS_WHATSAPP_PAIRING_OPTIONS,
      );
      if (!result.ok) {
        setState((previous) => ({
          ...previous,
          status: "error",
          error: result.error ?? "Failed to start pairing.",
        }));
      }
    } catch (cause) {
      setState((previous) => ({
        ...previous,
        status: "error",
        error: formatPairingError(cause),
      }));
    }
  }, [accountId]);

  const stopPairing = useCallback(async () => {
    try {
      await client.stopWhatsAppPairing(
        accountId,
        LIFEOPS_WHATSAPP_PAIRING_OPTIONS,
      );
      setState({
        status: "idle",
        qrDataUrl: null,
        phoneNumber: null,
        error: null,
      });
    } catch (cause) {
      setState((previous) => ({
        ...previous,
        status: "error",
        error: formatPairingError(cause),
      }));
    }
  }, [accountId]);

  const disconnect = useCallback(async () => {
    try {
      await client.disconnectWhatsApp(
        accountId,
        LIFEOPS_WHATSAPP_PAIRING_OPTIONS,
      );
      setState({
        status: "idle",
        qrDataUrl: null,
        phoneNumber: null,
        error: null,
      });
    } catch (cause) {
      setState((previous) => ({
        ...previous,
        status: "error",
        error: formatPairingError(cause),
      }));
    }
  }, [accountId]);

  return { ...state, startPairing, stopPairing, disconnect };
}
