import { useChatComposer } from "@elizaos/app-core";
import { type ReactNode, useEffect } from "react";
import {
  type LifeOpsSelection,
  useLifeOpsSelection,
} from "./LifeOpsSelectionContext.js";

export interface PrefillChatDetail {
  text: string;
  select?: boolean;
}

export function postToChat(text: string): void {
  window.dispatchEvent(
    new CustomEvent<PrefillChatDetail>("milady:chat:prefill", {
      detail: { text, select: false },
    }),
  );
}

export function useLifeOpsChatAdapter(selection: LifeOpsSelection): {
  placeholder: string | null;
} {
  const { setChatInput } = useChatComposer();

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<PrefillChatDetail>).detail;
      if (!detail?.text) {
        return;
      }
      setChatInput(detail.text);
      window.requestAnimationFrame(() => {
        const ta = document.querySelector<HTMLTextAreaElement>(
          "[data-chat-composer-textarea]",
        );
        if (!ta) return;
        ta.focus();
        if (detail.select) {
          ta.select();
        }
      });
    };

    window.addEventListener("milady:chat:prefill", handler);
    return () => {
      window.removeEventListener("milady:chat:prefill", handler);
    };
  }, [setChatInput]);

  let placeholder: string | null = null;
  if (selection.reminderId) {
    placeholder = "Ask about this reminder…";
  } else if (selection.eventId) {
    placeholder = "Ask about this event…";
  } else if (selection.messageId) {
    placeholder = "Ask about this message…";
  }

  return { placeholder };
}

export function LifeOpsChatAdapter({ children }: { children: ReactNode }) {
  const { selection } = useLifeOpsSelection();
  const { placeholder } = useLifeOpsChatAdapter(selection);

  return (
    <div
      className="relative flex h-full flex-col"
      data-testid="lifeops-chat-adapter"
    >
      {placeholder ? (
        <div className="shrink-0 border-b border-border/12 bg-bg/60 px-4 py-1.5">
          <span className="text-xs text-muted">{placeholder}</span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

export function buildReplyPrefill(opts: {
  channel: string;
  sender: string;
  snippet: string;
  deepLink?: string | null;
}): string {
  const link = opts.deepLink ? ` — ${opts.deepLink}` : "";
  return `Please draft a reply to this ${opts.channel} message from ${opts.sender}: ${opts.snippet}${link}`;
}
