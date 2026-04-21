/**
 * LifeOpsChatAdapter — bridges LifeOps selections into the chat composer.
 *
 * Listens for milady:chat:prefill events and forwards them to the
 * ChatComposerContext so the composer textarea is seeded.
 * Also exposes postToChat() for non-React callers and
 * useLifeOpsChatAdapter() for inline selection context banners.
 */

import { useChatComposer } from "@elizaos/app-core";
import { type ReactNode, useEffect } from "react";
import {
  useLifeOpsSelection,
  type LifeOpsSelection,
} from "./LifeOpsSelectionContext.js";

export interface PrefillChatDetail {
  text: string;
  /** If true the textarea content is selected so the user can overwrite. */
  select?: boolean;
}

/** Dispatch a prefill event. Use this from outside React trees. */
export function postToChat(text: string): void {
  window.dispatchEvent(
    new CustomEvent<PrefillChatDetail>("milady:chat:prefill", {
      detail: { text, select: false },
    }),
  );
}

/**
 * Hook — call inside a component that is a descendant of ChatComposerCtx.
 * Listens for milady:chat:prefill and forwards the text to setChatInput.
 * Returns a contextual placeholder derived from the active selection.
 */
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

/**
 * LifeOpsChatAdapter component — wraps the chat slot.
 * Reads SelectionContext and shows a context banner when something is selected.
 */
export function LifeOpsChatAdapter({
  children,
}: {
  children: ReactNode;
}) {
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

/** Build a reply-prefill string from a message summary. */
export function buildReplyPrefill(opts: {
  channel: string;
  sender: string;
  snippet: string;
  deepLink?: string | null;
}): string {
  const link = opts.deepLink ? ` — ${opts.deepLink}` : "";
  return `Please draft a reply to this ${opts.channel} message from ${opts.sender}: ${opts.snippet}${link}`;
}
