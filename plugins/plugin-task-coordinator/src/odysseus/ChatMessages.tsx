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

// How long the Copy button shows its success glyph before reverting (odysseus
// chatRenderer.js footer-copy-btn reverts after 1500ms).
const COPY_FEEDBACK_MS = 1500;

/** Hover-revealed action footer for one assistant turn (odysseus
 * createMsgFooter). Copy is the only action with a real wired surface in the
 * orchestrator, so it is the only control shown — no dead edit/fork/delete
 * buttons, no memory pill without a recall source. Copy writes the turn's prose
 * to the clipboard and flips to a brief success glyph, matching the upstream
 * footer-copy-btn and the CodeBlock copy affordance. */
function AgentFooter({ content }: { content: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  // Revert timer for the success glyph; cleared on unmount and before re-arming
  // so a copy on a message that scrolls/unmounts within the window never sets
  // state on an unmounted component.
  const revertRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (revertRef.current !== null) clearTimeout(revertRef.current);
    },
    [],
  );

  const onCopy = useCallback(() => {
    // Guard for non-secure-context / older webviews where clipboard is absent.
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
      return;
    navigator.clipboard.writeText(content).then(
      () => {
        setCopied(true);
        if (revertRef.current !== null) clearTimeout(revertRef.current);
        revertRef.current = setTimeout(
          () => setCopied(false),
          COPY_FEEDBACK_MS,
        );
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
  sending,
}: {
  conversation: ConversationBlock[];
  locale?: string;
  // Reply-in-flight flag (the React analogue of odysseus chat.js `isStreaming`).
  // While true the history is marked aria-busy so screen readers wait for the
  // settled response instead of announcing every streamed token.
  sending?: boolean;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distance < 80;
  }, []);

  // While a reply streams, deltas coalesce into the same trailing block (stable
  // key, unchanged length), so length+key alone never re-fire the stick-to-
  // bottom effect and a pinned reader stops following. Track a per-kind growth
  // signal so the effect re-runs as the trailing block's content grows: user/
  // agent carry `content`, reasoning/notice carry `text`, and a trailing tool
  // card grows under a stable key via its output + status (neither content nor
  // text), so derive its signal from output length and the latest status.
  const lastBlock = conversation[conversation.length - 1];
  const lastContentSignal =
    lastBlock && "content" in lastBlock
      ? lastBlock.content.length
      : lastBlock && "text" in lastBlock
        ? lastBlock.text.length
        : lastBlock && lastBlock.kind === "tool"
          ? `${lastBlock.tool.output?.length ?? 0}:${lastBlock.tool.status}`
          : 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the derived signals below are the intended triggers
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [conversation.length, lastBlock?.key, lastContentSignal]);

  return (
    <div
      className="od-chat-history"
      ref={scrollRef}
      onScroll={onScroll}
      aria-busy={sending ? "true" : "false"}
    >
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
