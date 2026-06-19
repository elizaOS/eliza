import type * as React from "react";

import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";

interface ChatSearchHintProps {
  /**
   * Localized noun for what this view searches, e.g. "logs", "plugins", "people".
   * Kept short — it's interpolated into the hint copy.
   */
  noun: string;
  /** The live search query; when set, the hint confirms the active filter. */
  query?: string;
  className?: string;
}

/**
 * A small, always-visible in-view hint that tells the user this view's search
 * runs through the floating chat (the view registers a view→chat binding and has
 * no search box of its own). It lives in the view's OWN header — not on the chat
 * composer — so it stays visible even when the chat is collapsed to a pill, and
 * it's query-aware so it doubles as a "filter is live" confirmation.
 */
export function ChatSearchHint({
  noun,
  query,
  className,
}: ChatSearchHintProps): React.ReactElement {
  const { t } = useTranslation();
  const q = query?.trim();
  return (
    <p
      data-testid="chat-search-hint"
      className={cn("text-[13px] leading-relaxed text-txt/60", className)}
    >
      {q
        ? t("common.chatSearchActive", {
            noun,
            query: q,
            defaultValue: "Showing {{noun}} for “{{query}}”",
          })
        : t("common.chatSearchHint", {
            noun,
            defaultValue: "Search {{noun}} by typing in the chat.",
          })}
    </p>
  );
}
