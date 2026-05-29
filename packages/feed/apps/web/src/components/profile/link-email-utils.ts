import {
  isAuthAlreadyLinkedError,
  isAuthLinkFlowCancellationError,
} from "@/lib/auth-link-account-errors";

export function getLinkedEmail(
  authEmail?: string | null,
  storedEmail?: string | null,
): string | null {
  const normalizedAuthEmail = authEmail?.trim() || "";
  if (normalizedAuthEmail) return normalizedAuthEmail;

  const normalizedStored = storedEmail?.trim() || "";
  return normalizedStored || null;
}

/**
 * Returns true when the link-email flow was cancelled by the user.
 */
export const isLinkEmailFlowCancellationError =
  isAuthLinkFlowCancellationError;

/**
 * Returns true when auth reports that an email is already linked for the user.
 */
export const isLinkEmailAlreadyLinkedError = isAuthAlreadyLinkedError;
