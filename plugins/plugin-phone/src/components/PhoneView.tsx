/**
 * PhoneView — the single GUI/XR data wrapper for the Phone surface.
 *
 * It owns the live Android data (call-log fetch, dialer state, pending-number
 * handoff, place-call / open-dialer / Contacts-link actions) and renders the
 * one presentational {@link PhoneSpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` auto-detect GUI vs XR via
 * `window.__elizaXRContext`, so the SAME component serves both surfaces. The
 * TUI surface renders the same `PhoneSpatialView` through the terminal registry
 * (see `register-terminal-view.tsx`).
 */

import { Phone } from "@elizaos/capacitor-phone";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { consumeNavigateViewPayload } from "@elizaos/ui/app-navigate-view";
import { Button } from "@elizaos/ui/components/ui/button";
import { dispatchNavigateViewEvent } from "@elizaos/ui/events";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PhoneCallRow,
  type PhoneSnapshot,
  PhoneSpatialView,
  toPhoneCallRow,
} from "./PhoneSpatialView.tsx";
import { normalizeNumber } from "./phone-view-helpers.ts";

type PhoneNavigatePayload = {
  number?: unknown;
};

function consumePhoneNavigateNumber(): string | null {
  const payload = consumeNavigateViewPayload<PhoneNavigatePayload>("phone");
  return typeof payload?.number === "string" ? payload.number : null;
}

/** Short relative/absolute timestamp for a recent-call row. */
function formatWhen(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Open the separate Contacts view via the navigation bus. */
function openContacts(): void {
  if (typeof window === "undefined") return;
  dispatchNavigateViewEvent({ viewId: "contacts", viewPath: "/contacts" });
}

export function PhoneView() {
  const [dialed, setDialed] = useState("");
  const [callReady, setCallReady] = useState(false);
  const [calls, setCalls] = useState<PhoneCallRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshCalls = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // A null status means requestPermissions() itself threw — treat that as
      // "not granted" and stop. Otherwise we fall through to listRecentCalls,
      // which rejects ("READ_CALL_LOG permission is required") and Capacitor
      // logs the raw rejection to the console (#10196). Web reports "granted",
      // so the web/desktop path is unchanged.
      const status = await Phone.requestPermissions().catch(() => null);
      if (status?.phone !== "granted") {
        setCalls([]);
        setCallReady(false);
        setError(
          "Phone access is needed for recent calls and dialing. Grant it in your device settings, then retry.",
        );
        return;
      }
      const [phoneStatus, { calls: fetched }] = await Promise.all([
        Phone.getStatus().catch(() => null),
        Phone.listRecentCalls({ limit: 50 }),
      ]);
      setCallReady(phoneStatus?.canPlaceCalls ?? true);
      setCalls(
        fetched.map((entry) => toPhoneCallRow(entry, formatWhen(entry.date))),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCalls([]);
      setCallReady(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Seed the dialer from a cross-view handoff (e.g. a Contacts "Call" control).
  // Single-shot: the number is consumed so a later plain navigation does not
  // re-seed a stale value.
  useEffect(() => {
    const pending = consumePhoneNavigateNumber();
    if (pending) {
      setError(null);
      setDialed(normalizeNumber(pending));
    }
  }, []);

  // Load the recent-calls log on mount, then keep it fresh with a quiet 20s
  // poll. Torn down on unmount.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!autoLoadedRef.current) {
      autoLoadedRef.current = true;
      void refreshCalls();
    }
    const interval = setInterval(() => {
      void refreshCalls();
    }, 20_000);
    return () => clearInterval(interval);
  }, [refreshCalls]);

  const placeCall = useCallback(async (number: string) => {
    const normalized = normalizeNumber(number);
    if (!normalized) {
      setError("Enter a number to call.");
      return;
    }
    setError(null);
    try {
      await Phone.placeCall({ number: normalized });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const openDialer = useCallback(async () => {
    const number = normalizeNumber(dialed);
    setError(null);
    try {
      await Phone.openDialer(number ? { number } : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [dialed]);

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("key:")) {
        const key = action.slice(4);
        setError(null);
        if (key === "+") {
          // Leading + only when the input is empty (international dialing).
          setDialed((prev) => (prev.length === 0 ? "+" : prev));
          return;
        }
        setDialed((prev) => `${prev}${key}`);
        return;
      }
      if (action.startsWith("call-number:")) {
        void placeCall(action.slice("call-number:".length));
        return;
      }
      switch (action) {
        case "call":
          void placeCall(dialed);
          return;
        case "open-dialer":
          void openDialer();
          return;
        case "backspace":
          setError(null);
          setDialed((prev) => prev.slice(0, -1));
          return;
        case "contacts":
          openContacts();
          return;
        case "refresh":
          void refreshCalls();
          return;
      }
    },
    [dialed, openDialer, placeCall, refreshCalls],
  );

  const snapshot: PhoneSnapshot = {
    callReady,
    dialed,
    calls,
    loading,
    error,
  };

  // Expose the recent-call refresh and the dialer call action to the agent
  // surface. Both reuse the handlers this wrapper already owns (the same ones
  // the spatial Refresh / Call buttons dispatch through `onAction`), so the
  // agent can drive them directly on the GUI/XR surface; Call stays disabled
  // until the dialer holds a callable number, matching the `placeCall()` guard.
  const canCall = Boolean(normalizeNumber(dialed));
  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "phone-refresh",
    role: "button",
    label: "Refresh recent calls",
    group: "phone",
    description: "Reload the recent-call log from the device",
    status: loading ? "active" : "inactive",
  });
  const callControl = useAgentElement<HTMLButtonElement>({
    id: "phone-call",
    role: "button",
    label: "Call dialed number",
    group: "phone",
    description: "Place a call to the number currently in the dialer",
    status: canCall ? undefined : "disabled",
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          padding: "0.5rem",
          flexShrink: 0,
        }}
      >
        <Button
          ref={refreshControl.ref}
          {...refreshControl.agentProps}
          variant="outline"
          size="sm"
          onClick={() => void refreshCalls()}
          disabled={loading}
        >
          Refresh
        </Button>
        <Button
          ref={callControl.ref}
          {...callControl.agentProps}
          variant="outline"
          size="sm"
          onClick={() => void placeCall(dialed)}
          disabled={!canCall}
        >
          Call
        </Button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <PhoneSpatialView snapshot={snapshot} onAction={onAction} />
      </div>
    </div>
  );
}
