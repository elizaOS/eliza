import { useCallback, useEffect, useState } from "react";
import { client } from "../api/client";
import { DEFAULT_CONNECTOR_ACCOUNT_ID } from "./useConnectorAccounts";

export type { WhatsAppPairingStatus } from "../api/client-types-core";

import type { WhatsAppPairingStatus } from "../api/client-types-core";

interface WhatsAppPairingState {
  status: WhatsAppPairingStatus;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  error: string | null;
}

export function useWhatsAppPairing(accountId = DEFAULT_CONNECTOR_ACCOUNT_ID) {
  const [state, setState] = useState<WhatsAppPairingState>({
    status: "idle",
    qrDataUrl: null,
    phoneNumber: null,
    error: null,
  });

  useEffect(() => {
    client
      .getWhatsAppStatus(accountId)
      .then((res) => {
        if (res.authExists) {
          setState((prev) => ({
            ...prev,
            status: "connected",
          }));
        }
      })
      .catch(() => {
        // Non-fatal — just means we can't check initial status.
      });
  }, [accountId]);

  useEffect(() => {
    const unbindQr = client.onWsEvent(
      "whatsapp-qr",
      (data: Record<string, unknown>) => {
        if (data.accountId !== accountId) return;
        setState((prev) => ({
          ...prev,
          status: "waiting_for_qr",
          qrDataUrl: data.qrDataUrl as string,
        }));
      },
    );

    const unbindStatus = client.onWsEvent(
      "whatsapp-status",
      (data: Record<string, unknown>) => {
        if (data.accountId !== accountId) return;
        setState((prev) => ({
          ...prev,
          status: data.status as WhatsAppPairingStatus,
          phoneNumber: (data.phoneNumber as string) ?? prev.phoneNumber,
          error: (data.error as string) ?? null,
          qrDataUrl: data.status === "connected" ? null : prev.qrDataUrl,
        }));
      },
    );

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
      const result = await client.startWhatsAppPairing(accountId);
      if (!result.ok) {
        setState((prev) => ({
          ...prev,
          status: "error",
          error: result.error ?? "Failed to start pairing",
        }));
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [accountId]);

  const stopPairing = useCallback(async () => {
    await client.stopWhatsAppPairing(accountId).catch(() => {});
    setState({
      status: "idle",
      qrDataUrl: null,
      phoneNumber: null,
      error: null,
    });
  }, [accountId]);

  const disconnect = useCallback(async () => {
    await client.disconnectWhatsApp(accountId).catch(() => {});
    setState({
      status: "idle",
      qrDataUrl: null,
      phoneNumber: null,
      error: null,
    });
  }, [accountId]);

  return { ...state, startPairing, stopPairing, disconnect };
}
