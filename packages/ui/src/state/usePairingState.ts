/**
 * Pairing / auth state, one of the domain hooks AppContext composes.
 *
 * Manages the pairing code UI (input, submit, error, busy). The startup
 * effect sets pairingEnabled/pairingExpiresAt from the backend — those
 * setters are returned so AppContext can wire them.
 */

import { ElizaError } from "@elizaos/core/errors";
import { useCallback, useRef, useState } from "react";
import { client } from "../api";
import { resumeRemoteFirstRunAfterPairing } from "../first-run/adopt-remote-first-run";
import {
  persistActiveServerCredential,
  scrubRejectedActiveServerCredential,
} from "./active-server-credential";

export type PairingFailureCode =
  | "PAIRING_INVALID"
  | "PAIRING_EXPIRED"
  | "PAIRING_DISABLED"
  | "PAIRING_NOT_READY"
  | "PAIRING_INSTANCE_MISMATCH"
  | "PAIRING_RATE_LIMITED"
  | "PAIRING_SESSION_FAILED";

/** Converts the server's stable pairing verdict into an actionable UI state. */
export function pairingFailureMessage(error: unknown): string {
  const code = (error as { code?: string }).code as
    | PairingFailureCode
    | undefined;
  switch (code) {
    case "PAIRING_INVALID":
      return "The pairing code is invalid. Check the code and try again.";
    case "PAIRING_EXPIRED":
      return "Pairing code expired. Generate a new code and try again.";
    case "PAIRING_DISABLED":
      return "Pairing is disabled on this server. Ask the server owner to enable it.";
    case "PAIRING_NOT_READY":
      return "The server is still starting. Wait a moment and try the same code again.";
    case "PAIRING_INSTANCE_MISMATCH":
      return "The server instance changed. Refresh the code from the server and try again.";
    case "PAIRING_RATE_LIMITED":
      return "Too many attempts. Try again later.";
    case "PAIRING_SESSION_FAILED":
      return "The code was accepted, but the server could not create a session. Generate a new code and try again.";
    default: {
      const status = (error as { status?: number }).status;
      if (status === 410)
        return "Pairing code expired. Generate a new code and try again.";
      if (status === 429) return "Too many attempts. Try again later.";
      return "Pairing failed. Check the code and try again.";
    }
  }
}

export function usePairingState(onPaired: () => void) {
  const [pairingEnabled, setPairingEnabled] = useState(false);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const pairingBusyRef = useRef(false);
  const pairedApiBaseRef = useRef<string | null>(null);
  const pendingCredentialRef = useRef<{
    apiBase: string;
    token: string;
  } | null>(null);

  const handlePairingSubmit = useCallback(async () => {
    if (pairingBusyRef.current || pairingBusy) return;
    const apiBase = client.getBaseUrl();
    if (pairedApiBaseRef.current !== apiBase) pairedApiBaseRef.current = null;
    if (pendingCredentialRef.current?.apiBase !== apiBase)
      pendingCredentialRef.current = null;
    const code = pairingCodeInput.trim();
    if (!code && !pairedApiBaseRef.current && !pendingCredentialRef.current) {
      setPairingError("Enter the pairing code from your server.");
      return;
    }
    setPairingError(null);
    pairingBusyRef.current = true;
    setPairingBusy(true);
    try {
      if (!pairedApiBaseRef.current) {
        if (!pendingCredentialRef.current) {
          const { token } = await client.pair(code);
          pendingCredentialRef.current = { apiBase, token };
        }
        const { token } = pendingCredentialRef.current;
        if (client.getBaseUrl() !== apiBase) {
          pendingCredentialRef.current = null;
          throw new ElizaError(
            "The remote connection changed during pairing.",
            {
              code: "PAIRING_SUPERSEDED",
            },
          );
        }
        await persistActiveServerCredential(token, apiBase);
        if (client.getBaseUrl() !== apiBase) {
          pendingCredentialRef.current = null;
          throw new ElizaError(
            "The remote connection changed during pairing.",
            {
              code: "PAIRING_SUPERSEDED",
            },
          );
        }
        client.setToken(token);
        pairedApiBaseRef.current = apiBase;
      }
      await resumeRemoteFirstRunAfterPairing(client, apiBase);
      // Re-evaluate the authenticated session without replaying Capacitor's
      // launch URL in a new document (which would clear the paired credential).
      onPaired();
    } catch (err) {
      if ((err as { status?: number })?.status === 401) {
        const rejected = pendingCredentialRef.current;
        pairedApiBaseRef.current = null;
        pendingCredentialRef.current = null;
        if (rejected) scrubRejectedActiveServerCredential(rejected.token);
        setPairingCodeInput("");
        setPairingError(
          "The paired session was rejected. Enter a new pairing code.",
        );
        return;
      }
      setPairingError(
        pairedApiBaseRef.current
          ? `Paired, but remote setup failed: ${err instanceof Error ? err.message : String(err)}`
          : pairingFailureMessage(err),
      );
    } finally {
      pairingBusyRef.current = false;
      setPairingBusy(false);
    }
  }, [pairingBusy, pairingCodeInput, onPaired]);

  return {
    state: {
      pairingEnabled,
      pairingExpiresAt,
      pairingCodeInput,
      pairingError,
      pairingBusy,
    },
    setPairingEnabled,
    setPairingExpiresAt,
    setPairingCodeInput,
    handlePairingSubmit,
  };
}
