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
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { consumeNavigateViewPayload } from "@elizaos/ui/app-navigate-view";
import { Button } from "@elizaos/ui/components/ui/button";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type MessagesSnapshot,
  MessagesSpatialView,
} from "./MessagesSpatialView.tsx";
import { buildThreads, smsRole } from "./messages-view-helpers.ts";

type MessagesNavigatePayload = {
  recipient?: unknown;
};

function consumeMessagesNavigateRecipient(): string | null {
  const payload =
    consumeNavigateViewPayload<MessagesNavigatePayload>("messages");
  return typeof payload?.recipient === "string"
    ? payload.recipient.trim()
    : null;
}

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
    const pending = consumeMessagesNavigateRecipient();
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

  // Expose the inbox refresh and the compose-send to the agent surface. Both
  // reuse the handlers this wrapper already owns (the same ones the spatial
  // Refresh / Send buttons dispatch through `onAction`), so the agent can drive
  // them directly on the GUI/XR surface; Send stays disabled until the composer
  // has a recipient and a body, matching the `send()` guard.
  const canSend =
    composeAddress.trim().length > 0 &&
    composeBody.trim().length > 0 &&
    !sending;
  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "messages-refresh",
    role: "button",
    label: "Refresh messages",
    group: "messages",
    description: "Reload the SMS inbox from the device bridge",
    status: loading ? "active" : "inactive",
  });
  const sendControl = useAgentElement<HTMLButtonElement>({
    id: "messages-send",
    role: "button",
    label: "Send SMS",
    group: "messages",
    description: "Send the composed SMS to the current recipient",
    status: canSend ? undefined : "disabled",
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
          onClick={() => void refresh()}
          disabled={loading}
        >
          Refresh
        </Button>
        <Button
          ref={sendControl.ref}
          {...sendControl.agentProps}
          variant="outline"
          size="sm"
          onClick={() => void send()}
          disabled={!canSend}
        >
          Send
        </Button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <MessagesSpatialView snapshot={snapshot} onAction={onAction} />
      </div>
    </div>
  );
}
