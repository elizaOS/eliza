import type { ConversationMessage } from "@elizaos/ui/api/client-types-chat";
import {
  VoicePill,
  type VoicePillMessage,
} from "@elizaos/ui/components/voice-pill";
import { useApp } from "@elizaos/ui/state";
import { useCallback, useMemo } from "react";

/**
 * AndroidVoicePill
 *
 * Renders the shared `<VoicePill>` from `@elizaos/ui` as a fixed overlay at
 * the bottom of the Capacitor WebView. When Eliza is registered as the
 * Android launcher (see
 * `eliza/packages/os/android/vendor/eliza/apps/Eliza/Android.bp` and
 * `android/app/src/main/AndroidManifest.xml`'s HOME intent category), this
 * pill is always visible on the home surface.
 *
 * The Android pill mounts inside the same React tree as the main chat
 * composer, so it consumes `useApp()` directly: messages are read from
 * `conversationMessages`, sends go through `sendChatText`, and the pinned
 * conversation is whatever the main shell has active. That keeps the pill
 * fully in-context with whatever conversation the user is in, without a
 * second transport.
 */

// The pill is a compact overlay; cap the message tail so a long thread can't
// blow the panel out.
const PILL_MESSAGE_TAIL = 20;

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

  const handleRecordingChange = useCallback((_recording: boolean): void => {
    // TODO: route recording start/stop through the shared voice capture
    // pipeline at `eliza/packages/ui/src/voice/local-asr-capture.ts` +
    // `eliza/packages/ui/src/voice/voice-chat-recording.ts`. The main
    // composer wires this via `useChatVoiceSession` — once that hook is
    // refactored to be reusable outside the composer shell, swap this stub
    // for a real start/stop call that funnels the transcript through
    // `sendChatText` above.
  }, []);

  return (
    <VoicePill
      messages={messages}
      onSubmit={handleSubmit}
      onRecordingChange={handleRecordingChange}
    />
  );
}

export default AndroidVoicePill;
