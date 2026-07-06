/**
 * Live-model leg of #14325 ("settings is just settings in chat"): when the owner
 * asks in chat to configure a connector plugin, the agent must emit the
 * `[CONFIG:<pluginId>]` inline marker so the chat surface renders the
 * InlinePluginConfig card (fetch/edit/save/enable) instead of dumping a wall of
 * text or a plaintext secret form. This asserts the emitted marker on the real
 * model's response — the marker is the contract the ChatView / overlay parser
 * (`packages/ui/src/components/chat/message-parser-helpers`) keys the card on, so
 * emitting it is what makes chat a settings surface.
 *
 * The card's own fetch/edit/save/enable round-trip is proven deterministically
 * in `packages/ui/src/components/chat/MessageContent.config.test.tsx`; this
 * scenario proves the *live model actually emits the marker* for a natural
 * request, which no deterministic proxy can prove (the proxy always echoes).
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "settings-in-chat-config-card",
  title: "Agent emits [CONFIG:telegram] card when asked to configure a plugin",
  domain: "app-control",
  tags: ["app-control", "settings", "chat-widgets", "config-card", "14325"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  rooms: [
    {
      id: "main",
      source: "chat",
      title: "Settings In Chat — Config Card",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner-asks-to-configure-telegram",
      text: "I want to set up the telegram connector — show me its configuration.",
      // The card contract: the response body must carry the [CONFIG:telegram]
      // marker the parser lifts into an InlinePluginConfig segment. A scoped id
      // (@elizaos/plugin-telegram) normalizes to `telegram`, so accept either.
      responseIncludesAny: [/\[CONFIG:(@elizaos\/plugin-)?telegram\]/i],
      // Must NOT hand the owner a plaintext [FORM] for a secret-bearing config —
      // secret-key entry routes through the sensitive-request flow, never a
      // plain inline form (ui-catalog [FORM] prohibition).
      responseExcludes: [/\[FORM[:\]]/i],
    },
  ],
});
