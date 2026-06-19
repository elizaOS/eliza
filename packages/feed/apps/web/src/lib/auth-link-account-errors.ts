export const AUTH_LOGIN_ERROR_MESSAGES = {
  DEFAULT: "Failed to log in. Please try again.",
  METAMASK:
    "Failed to connect to MetaMask. Please try again or choose a different login method.",
} as const;

export function getAuthErrorMessage(error: unknown): string | null {
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

export function isAuthFlowCancellationError(error: unknown): boolean {
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

  const message = getAuthErrorMessage(error);
  if (message === "Authentication cancelled") return true;
  if (message === "Proposal expired") return true;

  return false;
}

export function isAuthLinkFlowCancellationError(error: unknown): boolean {
  return isAuthFlowCancellationError(error);
}

export function getAuthLoginErrorMessage(error: unknown): string {
  const message = getAuthErrorMessage(error)?.toLowerCase();
  if (!message) return AUTH_LOGIN_ERROR_MESSAGES.DEFAULT;

  if (message.includes("failed to connect to metamask")) {
    return AUTH_LOGIN_ERROR_MESSAGES.METAMASK;
  }

  return AUTH_LOGIN_ERROR_MESSAGES.DEFAULT;
}

export function isAuthAlreadyLinkedError(error: unknown): boolean {
  if (error === "cannot_link_more_of_type") return true;

  if (typeof error === "object" && error !== null) {
    const e = error as { code?: string; authErrorCode?: string };
    if (
      e.code === "cannot_link_more_of_type" ||
      e.authErrorCode === "cannot_link_more_of_type"
    ) {
      return true;
    }
  }

  return false;
}

export function isAuthTwitterLinkConflictError(error: unknown): boolean {
  const message = getAuthErrorMessage(error);
  if (!message) return false;

  return message
    .toLowerCase()
    .includes("already has an account of type twitter linked");
}
