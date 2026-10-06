/**
 * Presentation helpers for the conversations sidebar: localized title fallback
 * ("New Chat"), a stable avatar index hashed from a conversation id, provider
 * label resolution from a model string, an embedding/utility-model classifier,
 * and the browser/computer capability plugin-id sets used to badge rows. Pure
 * and framework-free (re-exports `formatRelativeTime` for callers).
 */

import { formatRelativeTime } from "../../utils/format";

export { formatRelativeTime };

export function getLocalizedConversationTitle(
  title: string | undefined | null,
  t: (
    key: string,
    vars?: Record<string, string | number | boolean | null | undefined>,
  ) => string,
): string {
  const trimmed = title?.trim() ?? "";
  if (
    !trimmed ||
    trimmed === "New Chat" ||
    trimmed === "companion.newChat" ||
    trimmed.toLowerCase() === "default"
  ) {
    const localized = t("common.newChat");
    return localized === "companion.newChat" ? "New Chat" : localized;
  }
  return trimmed;
}
