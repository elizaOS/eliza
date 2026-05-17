import { Capacitor } from "@capacitor/core";
import {
  type ConversationMessage,
  useApp,
  VoicePill,
  type VoicePillMessage,
} from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import VoicePillOverlay from "../native/voice-pill-overlay";

/**
 * AndroidVoicePill
 *
 * Renders the shared `<VoicePill>` from `@elizaos/ui` as a fixed overlay at
 * the bottom of the Capacitor WebView, and — when the platform is Android
 * AND `SYSTEM_ALERT_WINDOW` has been granted — also asks the native
 * `VoicePillPlugin` to spin up `ElizaVoicePillOverlayService`, which draws
 * a real system overlay above other apps via `WindowManager` +
 * `TYPE_APPLICATION_OVERLAY`.
 *
 * When the system overlay is active the in-WebView pill is hidden, since
 * it would only be visible while Eliza is the foreground app and the
 * native overlay is now the canonical surface. When permission is not
 * granted the in-WebView pill stays visible and exposes a "Pin to home
 * screen" affordance that triggers the permission request flow.
 *
 * Both surfaces send + receive through the same `AppProvider` chat state
 * the main composer uses (`sendChatText`, `conversationMessages`,
 * `activeConversationId`), so the pill is contextual to whatever
 * conversation the user is in.
 */

// The pill is a compact overlay; cap the message tail so a long thread
// can't blow the panel out.
const PILL_MESSAGE_TAIL = 20;

type OverlayMode = "checking" | "system" | "webview";

function toPillMessage(message: ConversationMessage): VoicePillMessage | null {
  const text = message.text?.trim() ?? "";
  if (!text) return null;
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "agent",
    text,
  };
}

function projectPillMessages(
  source: ConversationMessage[],
): VoicePillMessage[] {
  const tail = source.slice(-PILL_MESSAGE_TAIL);
  const projected: VoicePillMessage[] = [];
  for (const entry of tail) {
    const pill = toPillMessage(entry);
    if (pill) projected.push(pill);
  }
  return projected;
}

export function AndroidVoicePill() {
  const { conversationMessages, activeConversationId, sendChatText } = useApp();
  const [overlayMode, setOverlayMode] = useState<OverlayMode>("checking");
  const [recording, setRecording] = useState<boolean>(false);
  const mountedRef = useRef<boolean>(true);

  const isAndroid = Capacitor.getPlatform() === "android";

  // Drive the in-WebView pill from the same conversation state the main
  // composer renders, so messages stay in sync without a separate transport.
  const messages = useMemo(
    () => projectPillMessages(conversationMessages),
    [conversationMessages],
  );

  const handleSubmit = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (!trimmed) return;
      void sendChatText(trimmed, {
        conversationId: activeConversationId ?? null,
      });
    },
    [sendChatText, activeConversationId],
  );

  const handleRecordingChange = useCallback(
    (next: boolean): void => {
      setRecording(next);
      if (overlayMode === "system") {
        void VoicePillOverlay.setRecording({ recording: next });
      }
      // TODO: route recording start/stop through the shared voice capture
      // pipeline at `eliza/packages/ui/src/voice/local-asr-capture.ts` +
      // `eliza/packages/ui/src/voice/voice-chat-recording.ts`. The main
      // composer wires this via `useChatVoiceSession` — once that hook is
      // refactored to be reusable outside the composer shell, swap this
      // setRecording-only stub for a real start/stop call that submits the
      // transcript via `sendChatText` above.
    },
    [overlayMode],
  );

  // Mirror the live message tail into the native overlay so the out-of-app
  // surface stays in sync with the WebView surface. Only run when the
  // native overlay is the canonical surface.
  useEffect(() => {
    if (overlayMode !== "system") return;
    const latest = messages[messages.length - 1];
    if (!latest || latest.role !== "agent") return;
    void VoicePillOverlay.pushAgentMessage({
      id: latest.id,
      text: latest.text,
    });
  }, [overlayMode, messages]);

  // Detect overlay permission + start the native service if granted.
  useEffect(() => {
    mountedRef.current = true;
    if (!isAndroid) {
      setOverlayMode("webview");
      return () => {
        mountedRef.current = false;
      };
    }

    let cancelled = false;
    void (async () => {
      const { granted } = await VoicePillOverlay.hasOverlayPermission();
      if (cancelled) return;
      if (granted) {
        await VoicePillOverlay.showOverlay();
        if (cancelled) return;
        setOverlayMode("system");
      } else {
        setOverlayMode("webview");
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [isAndroid]);

  // Bridge: native composer submissions → shared chat state. Funnel native-
  // overlay sends through the same store as WebView sends so ordering,
  // optimistic UI, and dedup all match.
  useEffect(() => {
    if (overlayMode !== "system") return;

    let handle: { remove(): Promise<void> } | null = null;
    void (async () => {
      handle = await VoicePillOverlay.addListener("messageSent", (event) => {
        if (!mountedRef.current) return;
        const trimmed = event.text?.trim() ?? "";
        if (!trimmed) return;
        void sendChatText(trimmed, {
          conversationId: activeConversationId ?? null,
        });
      });
    })();

    return () => {
      if (handle) {
        void handle.remove();
      }
    };
  }, [overlayMode, sendChatText, activeConversationId]);

  // Tear down the native service when this component unmounts.
  useEffect(() => {
    return () => {
      if (overlayMode === "system") {
        void VoicePillOverlay.hideOverlay();
      }
    };
  }, [overlayMode]);

  const handlePinToHomeScreen = useCallback(async (): Promise<void> => {
    const { granted } = await VoicePillOverlay.requestOverlayPermission();
    if (granted) {
      await VoicePillOverlay.showOverlay();
      setOverlayMode("system");
    }
  }, []);

  // While the system overlay is the canonical surface, suppress the
  // in-WebView pill so we don't render two pills on top of each other when
  // Eliza is the foreground app.
  if (overlayMode === "system") {
    return null;
  }

  if (overlayMode === "checking") {
    return null;
  }

  return (
    <>
      <VoicePill
        messages={messages}
        onSubmit={handleSubmit}
        recording={recording}
        onRecordingChange={handleRecordingChange}
      />
      {isAndroid ? (
        <button
          type="button"
          onClick={() => {
            void handlePinToHomeScreen();
          }}
          style={{
            position: "fixed",
            right: 16,
            bottom: 88,
            zIndex: 9999,
            padding: "8px 12px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.18)",
            color: "#FFF",
            border: "1px solid rgba(255,255,255,0.24)",
            fontSize: 12,
            backdropFilter: "blur(8px)",
          }}
        >
          Pin to home screen
        </button>
      ) : null}
    </>
  );
}

export default AndroidVoicePill;
