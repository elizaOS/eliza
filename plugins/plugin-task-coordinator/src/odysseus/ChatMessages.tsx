// The message log. Reuses buildConversation's block list: user/agent turns are
// rendered as odysseus bubbles; tool/reasoning/notice blocks reuse the shared
// ConversationBlockView (which inherits the odysseus palette via the remapped
// theme vars). Sticks to the newest entry unless the user has scrolled up.
//
// Assistant turns carry a hover-revealed action footer (odysseus chatRenderer.js
// createMsgFooter). Of odysseus's seven footer actions only Copy has a real
// backing surface in eliza's orchestrator — edit / regenerate-from-here /
// rewrite-shorter / explain-simpler / fork / delete all require message-mutation
// endpoints the orchestrator does not expose, and the "memory used" pill needs a
// recall source the stream never emits. Rather than render dead controls that
// route nowhere, the footer ships the honest, wired subset: a single Copy button
// (the same affordance as the upstream footer-copy-btn) over the turn's prose.
// The remaining actions + metrics belong with the streaming/message-mutation
// layer (useChatSubmit.ts, orchestrator-stream.tsx) and are tracked there.

import { Check, Copy } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ConversationBlock } from "../orchestrator-stream";
import { ConversationBlockView } from "../orchestrator-stream";
import { AgentBubble, UserBubble } from "./MessageBubble";

type AgentBlock = Extract<ConversationBlock, { kind: "agent" }>;

/** Hover-revealed action footer for one assistant turn (odysseus
 * createMsgFooter). Copy is the only action with a real wired surface in the
 * orchestrator, so it is the only control shown — no dead edit/fork/delete
 * buttons, no memory pill without a recall source. Copy writes the turn's prose
 * to the clipboard and flips to a brief success glyph, matching the upstream
 * footer-copy-btn and the CodeBlock copy affordance. */
function AgentFooter({ content }: { content: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    // Guard for non-secure-context / older webviews where clipboard is absent.
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
      return;
    navigator.clipboard.writeText(content).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  }, [content]);

  return (
    <div className="od-msg-footer">
      <span className="od-msg-actions">
        <button
          type="button"
          className="od-footer-copy-btn"
          title={copied ? "Copied" : "Copy message"}
          aria-label={copied ? "Copied" : "Copy message"}
          data-copied={copied ? "true" : undefined}
          onClick={onCopy}
        >
          {copied ? (
            <Check width="14" height="14" aria-hidden="true" />
          ) : (
            <Copy width="14" height="14" aria-hidden="true" />
          )}
        </button>
      </span>
    </div>
  );
}

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
        if (block.kind === "agent") {
          const agent: AgentBlock = block;
          return (
            <div className="od-msg-group" key={agent.key}>
              <AgentBubble block={agent} locale={locale} />
              <AgentFooter content={agent.content} />
            </div>
          );
        }
        return (
          <div className="od-msg-cells" key={block.key}>
            <ConversationBlockView block={block} locale={locale} />
          </div>
        );
      })}
    </div>
  );
}
