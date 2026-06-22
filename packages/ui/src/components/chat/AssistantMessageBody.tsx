import * as React from "react";
import type {
  ChatFailureKind,
  ConversationMessage,
  MessageAttachment,
} from "../../api/client-types-chat";
import { MessageContent } from "./MessageContent";

/**
 * The minimal slice of a conversation turn the rich renderer needs. Both the
 * dashboard chat (`ConversationMessage`) and the shell overlay (`ShellMessage`,
 * whose body field is `content` rather than `text`) satisfy this, so a single
 * adapter feeds both surfaces through the same segment/markdown/widget pipeline.
 */
export interface AssistantMessageBodySource {
  id: string;
  role: "user" | "assistant";
  /** Visible turn text. `ShellMessage` calls this `content`; map it before passing. */
  text: string;
  failureKind?: ChatFailureKind;
  reasoning?: string;
  attachments?: MessageAttachment[];
}

/**
 * Canonical renderer for an assistant turn's body, shared by the dashboard chat
 * and the continuous-chat overlay.
 *
 * WHY THIS EXISTS:
 * The overlay used to render assistant `content` as a RAW TEXT NODE, so a turn
 * carrying `[CONFIG:...]` markers, inline widgets, permission cards, UiSpec blocks,
 * or hidden `<think>` fragments showed as marker text on the primary chat
 * surface while the dashboard `ChatView` path rendered the same turn as rich
 * interactive segments via `MessageContent`. The two surfaces also re-implemented
 * the slash-bold and `no_provider` gate logic independently, and drifted.
 *
 * This component delegates to `MessageContent` (the canonical rich renderer) so
 * Both surfaces parse and render identically: config/widget/permission/ui-spec
 * segments, markdown text, `<think>`-tag stripping, the `no_provider` /
 * `rate_limited` / `provider_issue` gates, local-model gates, attachments, and
 * the reasoning `ThinkingBlock` are all handled in one place.
 *
 * `MessageContent` reads `setTab` / `sendActionMessage` / `handleChatRetry` from
 * the app store and the chat composer, so this must render inside `<AppProvider>`
 * (the real shell always does; story/test harnesses wrap with the mock provider).
 */
export const AssistantMessageBody = React.memo(function AssistantMessageBody({
  message,
}: {
  message: AssistantMessageBodySource;
}): React.JSX.Element {
  // Adapt the source turn to the `ConversationMessage` shape `MessageContent`
  // consumes. `timestamp` is unused by the renderer but required by the type;
  // the turn's stable id is the only field that participates in keys/memoization.
  const conversationMessage = React.useMemo<ConversationMessage>(
    () => ({
      id: message.id,
      role: message.role,
      text: message.text,
      timestamp: 0,
      ...(message.failureKind ? { failureKind: message.failureKind } : {}),
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
    }),
    [
      message.id,
      message.role,
      message.text,
      message.failureKind,
      message.reasoning,
      message.attachments,
    ],
  );

  return <MessageContent message={conversationMessage} />;
});
