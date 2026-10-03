/**
 * PhoneView — the single GUI data wrapper for the Phone surface.
 *
 * It owns the live Android data (call-log fetch, dialer state, pending-number
 * handoff, place-call / open-dialer / Contacts-link actions) and renders the
 * one presentational {@link PhoneSpatialView} inside a {@link SpatialSurface}.
 * The spatial child is presentational only, which keeps native call loading and
 * dialer dispatch isolated in this wrapper.
 */

import { Phone } from "@elizaos/plugin-native-phone/bridge";
import { consumeNavigateViewPayload } from "@elizaos/ui/app-navigate-view";
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
  const [historyStatus, setHistoryStatus] =
    useState<PhoneSnapshot["historyStatus"]>("loading");
  const [error, setError] = useState<string | null>(null);

  const refreshCalls = useCallback(async () => {
    setHistoryStatus("loading");
    setError(null);
    try {
      const status = await Phone.requestPermissions();
      if (status.phone !== "granted") {
        setCalls([]);
        setCallReady(false);
        setHistoryStatus("unavailable");
        setError(
          "Phone access is needed for recent calls and dialing. Grant it in your device settings, then retry.",
        );
        return;
      }
      const [phoneStatus, { calls: fetched }] = await Promise.all([
        Phone.getStatus(),
        Phone.listRecentCalls({ limit: 50 }),
      ]);
      setCallReady(phoneStatus.canPlaceCalls);
      setCalls(
        fetched.map((entry) => toPhoneCallRow(entry, formatWhen(entry.date))),
      );
      setHistoryStatus("ready");
    } catch (err) {
      // error-policy:J4 Bridge failures remain visible and disable calling until a successful refresh.
      setError(err instanceof Error ? err.message : String(err));
      setCalls([]);
      setCallReady(false);
      setHistoryStatus("unavailable");
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
      // error-policy:J4 Bridge failures remain visible and disable calling until a successful refresh.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const openDialer = useCallback(async () => {
    const number = normalizeNumber(dialed);
    setError(null);
    try {
      await Phone.openDialer(number ? { number } : undefined);
    } catch (err) {
      // error-policy:J4 Bridge failures remain visible and disable calling until a successful refresh.
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
    historyStatus,
    error,
  };

  return <PhoneSpatialView snapshot={snapshot} onAction={onAction} />;
}
