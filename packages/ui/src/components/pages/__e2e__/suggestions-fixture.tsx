/**
 * Browser fixture for the proactive-suggestions e2e (#8792) — phase 2 of
 * run-suggestions-e2e.mjs.
 *
 * Renders the REAL transcript pipeline a governed proactive comment flows
 * through on the client: the real `parseProactiveMessageEvent` WS-frame parser
 * (state/parsers — the exact function the shell's `proactive-message` WS
 * subscriber calls) feeding the real `ChatTranscript` → `ChatMessage`
 * composites, which render the #8792 suggestion affordance (Suggestion chip +
 * "Do it" + dismiss) for `source: "proactive-interaction"` messages.
 *
 * The dismiss/accept handlers mirror ChatView's wiring exactly: dismiss removes
 * the bubble locally; accept sends "Yes, let's do it." as a normal turn and then
 * clears the bubble. The runner feeds this fixture REAL frames captured from the
 * real server pipeline (views/interactions routes → decider → gate →
 * routeAutonomyTextToUser → broadcast) in phase 1 — no hand-written frames for
 * the happy path.
 */

import * as React from "react";
import { useCallback, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationMessage } from "../../../api/client-types-chat";
import { parseProactiveMessageEvent } from "../../../state/parsers";
import { ChatTranscript } from "../../composites/chat/chat-transcript";
import type { ChatMessageData } from "../../composites/chat/chat-types";

interface DeliverResult {
  delivered: boolean;
  reason: string;
}

type Win = typeof window & {
  __deliverWsFrame?: (frame: Record<string, unknown>) => DeliverResult;
  __sentTexts?: string[];
  __unreadConversations?: string[];
};

const ACTIVE_CONVERSATION_ID = "conv-1";

function Harness(): React.JSX.Element {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);

  useLayoutEffect(() => {
    const win = window as Win;
    win.__sentTexts = win.__sentTexts ?? [];
    win.__unreadConversations = win.__unreadConversations ?? [];
    // Same ingest contract as the shell's `proactive-message` WS subscriber
    // (state/startup-phase-hydrate): parse with the real parser; append to the
    // active conversation (id-deduped); other conversations go unread.
    win.__deliverWsFrame = (frame) => {
      const parsed = parseProactiveMessageEvent(frame);
      if (!parsed) return { delivered: false, reason: "unparseable frame" };
      if (parsed.conversationId !== ACTIVE_CONVERSATION_ID) {
        win.__unreadConversations?.push(parsed.conversationId);
        return { delivered: false, reason: "inactive conversation → unread" };
      }
      let appended = false;
      setMessages((prev) => {
        if (prev.some((m) => m.id === parsed.message.id)) return prev;
        appended = true;
        return [...prev, parsed.message];
      });
      return {
        delivered: true,
        reason: appended ? "appended" : "id-deduped",
      };
    };
  }, []);

  // ChatView's handleDismissSuggestion: drop the bubble from the transcript.
  const handleDismissSuggestion = useCallback((messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, []);

  // ChatView's handleAcceptSuggestion: send the implied action as a normal
  // turn, then clear the suggestion bubble.
  const handleAcceptSuggestion = useCallback(
    (message: ChatMessageData) => {
      (window as Win).__sentTexts?.push("Yes, let's do it.");
      handleDismissSuggestion(message.id);
    },
    [handleDismissSuggestion],
  );

  return (
    <div
      data-testid="suggestions-fixture-root"
      style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}
    >
      <ChatTranscript
        agentName="Eliza"
        labels={{
          suggestion: "Suggestion",
          dismiss: "Dismiss suggestion",
          acceptSuggestion: "Do it",
        }}
        messages={messages}
        onDismissSuggestion={handleDismissSuggestion}
        onAcceptSuggestion={handleAcceptSuggestion}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
