// odysseus message bubbles (static/index.html .msg-user / .msg-ai). User turns
// are right-aligned rounded bubbles; agent turns are left bubbles with a model
// role header (dot + name) above flat markdown. Prose + code render through the
// shared MarkdownText so we don't re-solve markdown here.

import type { ReactNode } from "react";
import { MarkdownText } from "../orchestrator-markdown";
import type { ConversationBlock } from "../orchestrator-stream";
import { formatClockTime } from "../view-format";

type UserBlock = Extract<ConversationBlock, { kind: "user" }>;
type AgentBlock = Extract<ConversationBlock, { kind: "agent" }>;

export function UserBubble({
  block,
  locale,
}: {
  block: UserBlock;
  locale?: string;
}): ReactNode {
  return (
    <div className="od-msg od-msg-user">
      <div className="od-body">
        <MarkdownText text={block.content} />
      </div>
      <div className="od-msg-time">{formatClockTime(block.at, locale)}</div>
    </div>
  );
}

export function AgentBubble({
  block,
  locale,
}: {
  block: AgentBlock;
  locale?: string;
}): ReactNode {
  return (
    <div className="od-msg od-msg-ai">
      <div className="od-role">{block.senderName}</div>
      <div
        className="od-body"
        style={block.tone === "error" ? { color: "var(--red)" } : undefined}
      >
        <MarkdownText text={block.content} />
      </div>
      <div className="od-msg-time">{formatClockTime(block.at, locale)}</div>
    </div>
  );
}
