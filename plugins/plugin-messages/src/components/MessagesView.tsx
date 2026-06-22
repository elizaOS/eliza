/**
 * MessagesView — the single GUI/XR data wrapper for the Messages surface.
 *
 * It owns the live Android SMS data (inbox fetch, default-SMS role status,
 * compose state, pending-recipient handoff, send / request-role actions) and
 * renders the one presentational {@link MessagesSpatialView} inside a
 * {@link SpatialSurface}. Omitting the `modality` prop lets `SpatialSurface`
 * auto-detect GUI vs XR via `window.__elizaXRContext`, so the SAME component
 * serves both surfaces. The TUI surface renders the same `MessagesSpatialView`
 * through the terminal registry (see `register-terminal-view.tsx`).
 */

import type { SmsMessageSummary } from "@elizaos/capacitor-messages";
import { Messages } from "@elizaos/capacitor-messages";
import { System, type SystemStatus } from "@elizaos/capacitor-system";
import { consumePendingMessageRecipient } from "@elizaos/ui/app-navigate-view";
import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildThreads, smsRole } from "./MessagesAppView.helpers.ts";
import {
  type MessagesSnapshot,
  MessagesSpatialView,
} from "./MessagesSpatialView.tsx";

export function MessagesView() {
  const [messages, setMessages] = useState<SmsMessageSummary[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [composeAddress, setComposeAddress] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const statusResult = await System.getStatus().catch(() => null);
      setSystemStatus(statusResult);
      const perm = await Messages.requestPermissions().catch(() => null);
      if (perm && perm.sms !== "granted") {
        setMessages([]);
        setError(
          "SMS access is needed to read and send messages. Grant it in your device settings, then retry.",
        );
        return;
      }
      const messageResult = await Messages.listMessages({ limit: 200 });
      setMessages(messageResult.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount, then quietly poll so newly received SMS surface without a
  // manual control. The bridge has no push channel, so a 20s interval keeps the
  // thread list fresh; it is cleared on unmount.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!autoLoadedRef.current) {
      autoLoadedRef.current = true;
      void refresh();
    }
    const interval = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Seed the composer from a cross-view handoff (e.g. a Contacts "Message"
  // control that navigated here with a number). Single-shot: the recipient is
  // consumed so a later plain navigation does not re-seed a stale "To" field.
  useEffect(() => {
    const pending = consumePendingMessageRecipient();
    if (pending) {
      setSelectedThreadId(null);
      setComposeAddress(pending);
      setComposeBody("");
      setError(null);
    }
  }, []);

  const threads = useMemo(() => buildThreads(messages), [messages]);
  const currentSmsRole = smsRole(systemStatus);
  const ownsSmsRole = currentSmsRole?.held === true;
  const smsRoleHolder = currentSmsRole?.holders[0] ?? null;

  const openThread = useCallback(
    (threadId: string) => {
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;
      setSelectedThreadId(thread.id);
      setComposeAddress(thread.address);
      setError(null);
    },
    [threads],
  );

  const requestSmsRole = useCallback(async () => {
    setError(null);
    try {
      await System.requestRole({ role: "sms" });
      const next = await System.getStatus();
      setSystemStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const send = useCallback(async () => {
    const address = composeAddress.trim();
    const body = composeBody.trim();
    if (!address || !body || sending) return;
    setSending(true);
    setError(null);
    try {
      await Messages.sendSms({ address, body });
      setComposeBody("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [composeAddress, composeBody, refresh, sending]);

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("open-thread:")) {
        openThread(action.slice("open-thread:".length));
        return;
      }
      if (action.startsWith("compose-address:")) {
        setComposeAddress(action.slice("compose-address:".length));
        return;
      }
      if (action.startsWith("compose-body:")) {
        setComposeBody(action.slice("compose-body:".length));
        return;
      }
      switch (action) {
        case "send":
          void send();
          return;
        case "request-sms-role":
          void requestSmsRole();
          return;
        case "refresh":
          void refresh();
          return;
      }
    },
    [openThread, refresh, requestSmsRole, send],
  );

  const snapshot: MessagesSnapshot = {
    threads,
    selectedThreadId,
    composeAddress,
    composeBody,
    ownsSmsRole,
    smsRoleHolder,
    loading,
    error,
  };

  return (
    <SpatialSurface>
      <MessagesSpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
