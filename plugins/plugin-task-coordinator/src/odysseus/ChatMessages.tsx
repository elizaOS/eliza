// The message log. Reuses buildConversation's block list: user/agent turns are
// rendered as odysseus bubbles; tool/reasoning/notice blocks reuse the shared
// ConversationBlockView (which inherits the odysseus palette via the remapped
// theme vars). Sticks to the newest entry unless the user has scrolled up.

import { type ReactNode, useCallback, useEffect, useRef } from "react";
import type { ConversationBlock } from "../orchestrator-stream";
import { ConversationBlockView } from "../orchestrator-stream";
import { AgentBubble, UserBubble } from "./MessageBubble";

export function ChatMessages({
  conversation,
  locale,
}: {
  conversation: ConversationBlock[];
  locale?: string;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < 80;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation is the trigger
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [conversation.length, conversation[conversation.length - 1]?.key]);

  return (
    <div className="od-chat-history" ref={scrollRef} onScroll={onScroll}>
      {conversation.map((block) => {
        if (block.kind === "user")
          return <UserBubble key={block.key} block={block} locale={locale} />;
        if (block.kind === "agent")
          return <AgentBubble key={block.key} block={block} locale={locale} />;
        return (
          <div className="od-msg-cells" key={block.key}>
            <ConversationBlockView block={block} locale={locale} />
          </div>
        );
      })}
    </div>
  );
}
