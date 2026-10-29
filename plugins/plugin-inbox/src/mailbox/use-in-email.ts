/**
 * "Use in email": the review an assistant reply passes before it fills a local email draft.
 * The review names the account and the exact draft or message; the insert is refused if any of
 * them changed in the meantime. It only fills a local draft: sending still requires the composer
 * and the provider review. Pure, so a host's wording and limits are tested without a renderer.
 */
import type { SuggestionTarget } from "./drafts-controller.ts";

/** A suggestion destination with the account it belongs to. Tokens stay inside the renderer. */
export type EmailTarget = SuggestionTarget & {
  accountId?: string;
  account?: string;
};

/** The longest reply an email draft takes; a longer one is blocked, never cut short. */
export const USE_IN_EMAIL_MAXIMUM = 64000;

/** Selected Files and Photos are never attached by a suggestion; the composer's picker stays the only way. */
export const USE_IN_EMAIL_ATTACHMENT_POLICY =
  "Only this text is added. Files and photos are not attached; use Attach in the email to choose them.";

export interface EmailTargetDescription {
  account: string;
  destination: string;
  effect: string;
  confirmLabel: string;
  blocked: boolean;
}

/** What the review tells the user about the destination. */
export function describeEmailTarget(
  target: EmailTarget,
): EmailTargetDescription {
  if (!target.ready)
    return {
      account: target.account ? `From ${target.account}` : "",
      destination: "No email draft can take this suggestion yet.",
      effect: target.reason,
      confirmLabel: "Insert into draft",
      blocked: true,
    };
  const to = target.to.length ? target.to.join(", ") : "no recipients yet";
  const subject = target.subject.trim() || "(no subject)";
  // The literal address comes first; the sender's display name is their own text and only follows it.
  const destination =
    target.kind === "reply"
      ? target.to.length
        ? `New reply to ${to}${target.from ? ` (${target.from})` : ""} · ${subject}`
        : `New reply · ${subject} · no recipients yet`
      : target.kind === "draft"
        ? `Your ${target.aside ? "unfinished" : "open"} ${target.reply ? "reply" : "email"} draft${target.aside ? " (not on screen)" : ""} · ${subject} · to ${to}`
        : "A new email. You add the recipients and subject.";
  const effect = target.append
    ? "This draft already has text. The suggestion is added below it; nothing is replaced."
    : target.kind === "draft"
      ? "The draft has no message text yet. The suggestion becomes its text."
      : "A local draft opens with this text for you to edit.";
  return {
    account: `From ${target.account || "the selected Gmail account"}`,
    destination,
    // One draft exists per account: a set-aside draft takes the suggestion, not the message on screen.
    effect:
      target.kind === "draft" && target.elsewhere
        ? `This is not a reply to the message on screen. ${effect}`
        : effect,
    confirmLabel: target.append ? "Add below existing text" : "Insert into draft",
    blocked: false,
  };
}

/** A destination that cannot hold the whole reply is blocked in the review; text is never cut short. */
export function fitEmailTarget(found: EmailTarget, text: string): EmailTarget {
  if (!found.ready) return found;
  if (text.length > USE_IN_EMAIL_MAXIMUM)
    return {
      ...found,
      ready: false,
      reason:
        "This reply is longer than an email draft can hold. Copy the part you need instead.",
    } as EmailTarget;
  if (text.length > found.room)
    return {
      ...found,
      ready: false,
      reason:
        "The open draft does not have room for this whole reply. Copy the part you need instead. Nothing was added.",
    } as EmailTarget;
  return found;
}
