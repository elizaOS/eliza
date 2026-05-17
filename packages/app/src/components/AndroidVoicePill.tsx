import { useCallback, useState } from "react";
import { VoicePill, type VoicePillMessage } from "@elizaos/ui";

/**
 * AndroidVoicePill
 *
 * Renders the shared `<VoicePill>` from `@elizaos/ui` as a fixed overlay at the
 * bottom of the Capacitor WebView. When Eliza is registered as the Android
 * launcher (see `eliza/packages/os/android/vendor/eliza/apps/Eliza/Android.bp`
 * and `android/app/src/main/AndroidManifest.xml`'s HOME intent category), this
 * pill is always visible on the home surface.
 *
 * TODO(android-chat): wire `onSubmit` to the on-device agent's messaging route
 *   (see `packages/app-core/src/api/` for the canonical endpoint, and the iOS
 *   `fetchIosFullBunSmokeJson` flow in `main.tsx` ~line 1129 for an existing
 *   client-side send example). The current implementation is a local-state
 *   placeholder so the visual surface is wired end-to-end before the transport.
 */

const INITIAL_MESSAGES: VoicePillMessage[] = [
  { id: "a-welcome", role: "agent", text: "Hello, Shaw. What's on the list today?" },
];

const PLACEHOLDER_REPLY = "Acknowledged.";
const PLACEHOLDER_REPLY_DELAY_MS = 350;

export function AndroidVoicePill() {
  const [messages, setMessages] = useState<VoicePillMessage[]>(INITIAL_MESSAGES);

  const handleSubmit = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const userId = `u-${Date.now()}`;
    setMessages((prev) => [...prev, { id: userId, role: "user", text: trimmed }]);
    // Placeholder agent reply — replace with real on-device agent call.
    window.setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: "agent", text: PLACEHOLDER_REPLY },
      ]);
    }, PLACEHOLDER_REPLY_DELAY_MS);
  }, []);

  return <VoicePill messages={messages} onSubmit={handleSubmit} />;
}

export default AndroidVoicePill;
