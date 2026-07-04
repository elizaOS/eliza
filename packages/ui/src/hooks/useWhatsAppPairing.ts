/**
 * WhatsApp connector pairing state: polls the pairing status and exposes the
 * handshake verbs for the WhatsApp setup surface.
 */
import { useCallback, useEffect, useState } from "react";
import { client } from "../api/client";
import { DEFAULT_CONNECTOR_ACCOUNT_ID } from "./useConnectorAccounts";

export type { WhatsAppPairingStatus } from "../api/client-types-core";

import type { WhatsAppPairingStatus } from "../api/client-types-core";

const WHATSAPP_PAIRING_STATUSES: ReadonlySet<WhatsAppPairingStatus> = new Set([
  "idle",
  "initializing",
  "waiting_for_qr",
  "connected",
  "disconnected",
  "timeout",
  "error",
]);

function asPairingStatus(value: unknown): WhatsAppPairingStatus | null {
  return typeof value === "string" &&
    WHATSAPP_PAIRING_STATUSES.has(value as WhatsAppPairingStatus)
    ? (value as WhatsAppPairingStatus)
    : null;
}

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
        // error-policy:J4 initial-status probe is advisory; an unreachable
        // endpoint leaves status at "idle" (the designed default). The live
        // "whatsapp-status" WS stream below carries the real state once paired.
      });
  }, [accountId]);

  useEffect(() => {
    const unbindQr = client.onWsEvent(
      "whatsapp-qr",
      (data: Record<string, unknown>) => {
        if (data.accountId !== accountId) return;
        if (typeof data.qrDataUrl !== "string") return;
        const qrDataUrl = data.qrDataUrl;
        setState((prev) => ({
          ...prev,
          status: "waiting_for_qr",
          qrDataUrl,
        }));
      },
    );

    const unbindStatus = client.onWsEvent(
      "whatsapp-status",
      (data: Record<string, unknown>) => {
        if (data.accountId !== accountId) return;
        const status = asPairingStatus(data.status);
        if (!status) return;
        const phoneNumber =
          typeof data.phoneNumber === "string" ? data.phoneNumber : null;
        const error = typeof data.error === "string" ? data.error : null;
        setState((prev) => ({
          ...prev,
          status,
          phoneNumber: phoneNumber ?? prev.phoneNumber,
          error,
          qrDataUrl: status === "connected" ? null : prev.qrDataUrl,
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
    try {
      await client.stopWhatsAppPairing(accountId);
    } catch (err) {
      // A failed stop leaves the connector still pairing server-side; resetting
      // to "idle" would tell the user it stopped when it did not. Surface it.
      setState((prev) => ({
        ...prev,
        status: "error",
        error: err instanceof Error ? err.message : "Failed to stop pairing",
      }));
      return;
    }
    setState({
      status: "idle",
      qrDataUrl: null,
      phoneNumber: null,
      error: null,
    });
  }, [accountId]);

  const disconnect = useCallback(async () => {
    try {
      await client.disconnectWhatsApp(accountId);
    } catch (err) {
      // A swallowed failed disconnect renders "idle" over a still-connected
      // account — state corruption the user cannot see. Surface the failure.
      setState((prev) => ({
        ...prev,
        status: "error",
        error: err instanceof Error ? err.message : "Failed to disconnect",
      }));
      return;
    }
    setState({
      status: "idle",
      qrDataUrl: null,
      phoneNumber: null,
      error: null,
    });
  }, [accountId]);

  return { ...state, startPairing, stopPairing, disconnect };
}
