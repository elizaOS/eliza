/**
 * Pairing / auth state — extracted from AppContext.
 *
 * Manages the pairing code UI (input, submit, error, busy). The startup
 * effect sets pairingEnabled/pairingExpiresAt from the backend — those
 * setters are returned so AppContext can wire them.
 */

import { useCallback, useRef, useState } from "react";
import { client } from "../api";

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
      setPairingError("Enter the pairing code from the server logs.");
      return;
    }
    setPairingError(null);
    pairingBusyRef.current = true;
    setPairingBusy(true);
    try {
      const { token } = await client.pair(code);
      client.setToken(token);
      window.location.reload();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 410)
        setPairingError("Pairing code expired. Check logs for a new code.");
      else if (status === 429)
        setPairingError("Too many attempts. Try again later.");
      else setPairingError("Pairing failed. Check the code and try again.");
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
