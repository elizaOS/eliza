export const X_ACCOUNT_ALREADY_LINKED_MESSAGE =
  "This X account is already linked to another user";

export const PRIVY_LOGIN_ERROR_MESSAGES = {
  DEFAULT: "Failed to log in. Please try again.",
  METAMASK:
    "Failed to connect to MetaMask. Please try again or choose a different login method.",
} as const;

export function getPrivyErrorMessage(error: unknown): string | null {
  if (typeof error === "string") return error;

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return null;
}

/**
 * Returns true when the Privy auth flow was cancelled by the user.
 */
export function isPrivyAuthFlowCancellationError(error: unknown): boolean {
  if (error === "exited_auth_flow" || error === "exited_link_flow") return true;
  if (error === "Authentication cancelled") return true;

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "exited_auth_flow" || error.code === "exited_link_flow")
  ) {
    return true;
  }

  const message = getPrivyErrorMessage(error);
  if (message === "Authentication cancelled") return true;
  if (message === "Proposal expired") return true;

  return false;
}

/**
 * Returns true when the Privy link-account flow was cancelled by the user.
 */
export function isPrivyLinkFlowCancellationError(error: unknown): boolean {
  return isPrivyAuthFlowCancellationError(error);
}

/**
 * Returns a user-safe message for handled Privy login failures.
 */
export function getPrivyLoginErrorMessage(error: unknown): string {
  const message = getPrivyErrorMessage(error)?.toLowerCase();
  if (!message) return PRIVY_LOGIN_ERROR_MESSAGES.DEFAULT;

  if (message.includes("failed to connect to metamask")) {
    return PRIVY_LOGIN_ERROR_MESSAGES.METAMASK;
  }

  return PRIVY_LOGIN_ERROR_MESSAGES.DEFAULT;
}

/**
 * Returns true when Privy reports that a linked-account type is already
 * present (e.g. email already linked).
 */
export function isPrivyAlreadyLinkedError(error: unknown): boolean {
  if (error === "cannot_link_more_of_type") return true;

  if (typeof error === "object" && error !== null) {
    const e = error as { code?: string; privyErrorCode?: string };
    if (
      e.code === "cannot_link_more_of_type" ||
      e.privyErrorCode === "cannot_link_more_of_type"
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Returns true when Privy rejects X linking because the account is already
 * attached to another user.
 */
export function isPrivyTwitterLinkConflictError(error: unknown): boolean {
  const message = getPrivyErrorMessage(error);
  if (!message) return false;

  return message
    .toLowerCase()
    .includes("already has an account of type twitter linked");
}
