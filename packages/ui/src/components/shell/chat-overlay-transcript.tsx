/**
 * Adapts shell messages to canonical chat rows and selects the first-run turns
 * shown by the overlay. The shell owns navigation and interaction state while
 * this module owns transcript-only presentation policy.
 */

import type { ChatTurnStatus } from "../../api/client-types-chat";
import { splitLeadingSlashCommand } from "../../chat/slash-menu";
import {
  FIRST_RUN_GREETING,
  FIRST_RUN_SIGN_IN_PROMPT,
} from "../../first-run/first-run-greeting";
import { cn } from "../../lib/utils";
import { InlineWidgetText } from "../chat/InlineWidgetText";
import { MessageAttachments } from "../chat/MessageAttachments";
import {
  FormSubmitReceipt,
  SensitiveRequestBlock,
} from "../chat/MessageContent";
import { parseFormSubmitDisplay } from "../chat/message-parser-helpers";
import { ChatMessage } from "../composites/chat/chat-message";
import type {
  ChatMessageData,
  ChatMessageRenderContext,
} from "../composites/chat/chat-types";
import { TurnStatus } from "../composites/chat/chat-typing-indicator";
import { Button } from "../ui/button";
import type { ShellMessage } from "./shell-state";
import { WALLPAPER_FLOAT_SHADOW } from "./wallpaper-idiom";

function ThreadLineText({ content }: { content: string }): React.ReactNode {
  const formSubmit = parseFormSubmitDisplay(content);
  if (formSubmit) return <FormSubmitReceipt label={formSubmit.label} />;
  const slash = splitLeadingSlashCommand(content);
  if (!slash) return content;
  return (
    <>
      <span className="font-bold" data-testid="slash-command-token">
        {slash.command}
      </span>
      {slash.rest}
    </>
  );
}

/**
 * Keeps the pending label and first streamed reply in one line box while its
 * content changes; subsequent token updates retain the same subtree.
 */
function OverlayAssistantTurnBody({
  message,
  turnStatus,
}: {
  message: ChatMessageData;
  turnStatus: ChatTurnStatus | null;
}) {
  const attachmentsNode = message.attachments?.length ? (
    <MessageAttachments attachments={message.attachments} />
  ) : null;
  const pending =
    !message.text.trim() &&
    !message.attachments?.length &&
    !message.secretRequest;
  const phase = pending ? "status" : "reply";
  return (
    <div
      className="grid min-h-[1.4375rem] w-full min-w-0"
      data-testid="overlay-assistant-turn-body"
      data-phase={phase}
      data-has-message-text={message.text.trim() ? "true" : "false"}
    >
      {pending ? (
        <div className="col-start-1 row-start-1 flex min-h-[1.4375rem] items-center">
          <TurnStatus status={turnStatus} showLabel={false} />
        </div>
      ) : (
        <div className="col-start-1 row-start-1 min-h-[1.4375rem] min-w-0">
          <InlineWidgetText content={message.text} />
          {attachmentsNode}
          {message.secretRequest ? (
            <div className="pointer-events-auto">
              <SensitiveRequestBlock request={message.secretRequest} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function renderOverlayMessageBody(
  message: ChatMessageData,
  ctx: ChatMessageRenderContext | undefined,
  onOpenSettings: (() => void) | undefined,
): React.ReactNode {
  const isUser = message.role === "user";
  const attachmentsNode = message.attachments?.length ? (
    <MessageAttachments attachments={message.attachments} />
  ) : null;

  if (!isUser && message.failureKind === "no_provider") {
    return (
      <div
        className={cn(
          "max-w-[85%] rounded-2xl rounded-bl-md border border-accent/30 bg-scrim px-3.5 py-3 text-txt",
          WALLPAPER_FLOAT_SHADOW,
        )}
      >
        <div className="mb-1 text-[14px] font-medium">
          Connect a provider to chat
        </div>
        <div className="mb-2.5 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-strong [overflow-wrap:anywhere]">
          {message.text}
        </div>
        <Button
          variant="ghost"
          size="sm"
          data-testid="chat-no-provider-settings"
          onClick={() => onOpenSettings?.()}
          className="h-auto rounded-full border border-border-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-txt transition-colors hover:bg-bg-hover"
        >
          Open Settings
        </Button>
      </div>
    );
  }

  // A drained balance is terminal for this turn: retrying re-hits the same
  // empty balance, so the overlay renders the structured out-of-credits gate
  // (banner + Add credits CTA, no Retry chip) mirroring the ChatView surface.
  if (!isUser && message.failureKind === "insufficient_credits") {
    return (
      <div
        className={cn(
          "max-w-[85%] rounded-2xl rounded-bl-md border border-accent/30 bg-scrim px-3.5 py-3 text-txt",
          WALLPAPER_FLOAT_SHADOW,
        )}
      >
        <div className="mb-1 text-[14px] font-medium">Out of credits</div>
        <div className="mb-2.5 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-strong [overflow-wrap:anywhere]">
          {message.text}
        </div>
        <Button
          variant="ghost"
          size="sm"
          data-testid="chat-insufficient-credits-add"
          onClick={() => onOpenSettings?.()}
          className="h-auto rounded-full border border-border-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-txt transition-colors hover:bg-bg-hover"
        >
          Add credits
        </Button>
      </div>
    );
  }

  if (isUser) {
    return (
      <>
        <ThreadLineText content={message.text} />
        {attachmentsNode}
      </>
    );
  }

  return (
    <OverlayAssistantTurnBody
      message={message}
      turnStatus={ctx?.turnStatus ?? null}
    />
  );
}

const SPEAKING_TURN_STATUS: ChatTurnStatus = { kind: "speaking" };

export function SpeakingStatusAccessory(): React.JSX.Element {
  return (
    <span
      className="flex min-w-0 shrink-0 items-center whitespace-nowrap"
      data-testid="speaking-status-accessory"
    >
      <TurnStatus status={SPEAKING_TURN_STATUS} showLabel={false} />
    </span>
  );
}

const shellMessageDataCache = new WeakMap<ShellMessage, ChatMessageData>();

export function shellToChatMessageData(m: ShellMessage): ChatMessageData {
  const cached = shellMessageDataCache.get(m);
  if (cached) return cached;
  const data: ChatMessageData = {
    id: m.id,
    role: m.role,
    text: m.content,
    ...(Number.isFinite(m.createdAt) ? { timestamp: m.createdAt } : {}),
    ...(m.source ? { source: m.source } : {}),
    ...(m.interrupted ? { interrupted: true } : {}),
    ...(m.failureKind ? { failureKind: m.failureKind } : {}),
    ...(m.attachments ? { attachments: m.attachments } : {}),
    ...(m.secretRequest ? { secretRequest: m.secretRequest } : {}),
  };
  shellMessageDataCache.set(m, data);
  return data;
}

const FIRST_RUN_SIGN_IN_FALLBACK_MESSAGES: ShellMessage[] = [
  {
    id: "first-run:greeting-fallback",
    role: "assistant",
    source: "first_run",
    createdAt: 0,
    content: FIRST_RUN_GREETING,
  },
  {
    id: "first-run:cloud-signin-fallback",
    role: "assistant",
    source: "first_run",
    createdAt: 1,
    content: [
      FIRST_RUN_SIGN_IN_PROMPT,
      "",
      "[CHOICE:first-run id=runtime]",
      "__first_run__:runtime:cloud=Sign in to Eliza Cloud",
      "[/CHOICE]",
    ].join("\n"),
  },
];

export const FIRST_RUN_SIGN_IN_FALLBACK_DELAY_MS = 600;

export function isFirstRunShellMessage(m: ShellMessage): boolean {
  return (
    m.id.startsWith("first-run:") ||
    m.source === "first_run" ||
    m.source === "first-run"
  );
}

export function selectFirstRunDisplayMessages(
  messages: readonly ShellMessage[],
  showFallback: boolean,
): ShellMessage[] {
  const firstRunMessages = messages.filter(isFirstRunShellMessage);
  if (firstRunMessages.length === 0) {
    return showFallback ? FIRST_RUN_SIGN_IN_FALLBACK_MESSAGES : [];
  }

  const latest = firstRunMessages.at(-1);
  if (!latest) return [];
  const previous = firstRunMessages.at(-2);
  if (
    (previous?.id === "first-run:greeting" &&
      latest.id === "first-run:cloud-oauth") ||
    (previous?.id === "first-run:appearance" &&
      latest.id === "first-run:tutorial")
  ) {
    return [previous, latest];
  }
  return [latest];
}

export function __renderThreadLineForParity(
  message: ShellMessage,
  handlers?: {
    onAcceptSuggestion?: (message: ShellMessage) => void;
    onDismissSuggestion?: (messageId: string) => void;
  },
): React.JSX.Element {
  return (
    <ChatMessage
      appearance="glass"
      message={shellToChatMessageData(message)}
      onCopy={() => {}}
      onLongPressCopy={() => {}}
      renderContent={(m, ctx) => renderOverlayMessageBody(m, ctx, () => {})}
      onAcceptSuggestion={
        handlers?.onAcceptSuggestion
          ? () => handlers.onAcceptSuggestion?.(message)
          : undefined
      }
      onDismissSuggestion={handlers?.onDismissSuggestion}
    />
  );
}
