/**
 * Pairing / auth state, one of the domain hooks AppContext composes.
 *
 * Manages the pairing code UI (input, submit, error, busy). The startup
 * effect sets pairingEnabled/pairingExpiresAt from the backend — those
 * setters are returned so AppContext can wire them.
 */

import { useCallback, useRef, useState } from "react";
import { client } from "../api";
import { persistActiveServerCredential } from "./active-server-credential";

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

export function usePairingState() {
  const [pairingEnabled, setPairingEnabled] = useState(false);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const pairingBusyRef = useRef(false);

  const handlePairingSubmit = useCallback(async () => {
    if (pairingBusyRef.current || pairingBusy) return;
    const code = pairingCodeInput.trim();
    if (!code) {
      setPairingError("Enter the pairing code from your server.");
      return;
    }
    setPairingError(null);
    pairingBusyRef.current = true;
    setPairingBusy(true);
    try {
      const { token } = await client.pair(code);
      await persistActiveServerCredential(token, client.getBaseUrl());
      client.setToken(token);
      window.location.reload();
    } catch (err) {
      setPairingError(pairingFailureMessage(err));
    } finally {
      pairingBusyRef.current = false;
      setPairingBusy(false);
    }
  }, [pairingBusy, pairingCodeInput]);

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
