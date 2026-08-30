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

const PAIRING_PERSISTENCE_ERROR =
  "Pairing succeeded, but this device could not save the connection. Keep this window open and submit again to retry saving.";

export function usePairingState() {
  const [pairingEnabled, setPairingEnabled] = useState(false);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const pairingBusyRef = useRef(false);
  const pendingCredentialRef = useRef<{
    token: string;
    apiBase: string;
  } | null>(null);

  const handlePairingSubmit = useCallback(async () => {
    // The ref is the synchronous submit lock. React state only renders the busy
    // indicator and may still hold the previous request's value for one render.
    if (pairingBusyRef.current) return;
    const pendingCredential = pendingCredentialRef.current;
    const code = pairingCodeInput.trim();
    if (!pendingCredential && !code) {
      setPairingError("Enter the pairing code from your server.");
      return;
    }
    setPairingError(null);
    pairingBusyRef.current = true;
    setPairingBusy(true);
    try {
      let credential = pendingCredential;
      if (!credential) {
        try {
          const { token } = await client.pair(code);
          credential = { token, apiBase: client.getBaseUrl() };
          pendingCredentialRef.current = credential;
        } catch (err) {
          // error-policy:J4 pairing HTTP statuses become distinct recovery
          // guidance while the one-use code has not succeeded.
          const status = (err as { status?: number }).status;
          if (status === 410)
            setPairingError(
              "Pairing code expired. Generate a new code and try again.",
            );
          else if (status === 429)
            setPairingError("Too many attempts. Try again later.");
          else setPairingError("Pairing failed. Check the code and try again.");
          return;
        }
      }

      try {
        await persistActiveServerCredential(
          credential.token,
          credential.apiBase,
        );
      } catch {
        // error-policy:J4 the server already consumed the one-use code, so keep
        // the issued credential and retry only durable persistence.
        setPairingError(PAIRING_PERSISTENCE_ERROR);
        return;
      }

      client.setToken(credential.token);
      pendingCredentialRef.current = null;
      window.location.reload();
    } finally {
      pairingBusyRef.current = false;
      setPairingBusy(false);
    }
  }, [pairingCodeInput]);

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
