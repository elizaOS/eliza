/** Defines connector-side identity-link code recognition and user replies. */

const LINK_CODE_PATTERN = /\bLINK-([A-HJ-NP-Z2-9]{8})\b/i;

export function extractIdentityLinkCode(
  text: string | undefined,
): string | null {
  if (!text) return null;
  const match = LINK_CODE_PATTERN.exec(text);
  return match ? `LINK-${match[1].toUpperCase()}` : null;
}

export function identityLinkReply(status: string): string {
  switch (status) {
    case "linked":
      return "You're linked! This messaging account is now connected to your eliza.app account. Just keep chatting here.";
    case "expired":
      return "That link code has expired. Generate a fresh one from your eliza.app settings and send it here within 10 minutes.";
    case "already_used":
      return "That link code was already used. If this wasn't you, generate a new code from your eliza.app settings.";
    case "platform_mismatch":
      return "That link code was created for a different platform. Generate a code for this platform from your eliza.app settings.";
    case "handle_conflict":
      return "This messaging account is already linked to a different eliza.app account, so the code can't be applied.";
    default:
      return "That doesn't look like a valid link code. Double-check it or generate a new one from your eliza.app settings.";
  }
}
