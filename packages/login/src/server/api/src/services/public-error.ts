const PUBLIC_API_ERROR_MESSAGES = {
  resource_already_exists: "Resource already exists",
  resource_not_found: "Resource not found",
  unsupported_chain: "Unsupported chain",
} as const;

export type PublicApiErrorCode = keyof typeof PUBLIC_API_ERROR_MESSAGES;

/** A typed error whose public text is selected from a closed, stable table. */
export class PublicApiError extends Error {
  readonly publicMessage: string;

  constructor(readonly code: PublicApiErrorCode) {
    const publicMessage = PUBLIC_API_ERROR_MESSAGES[code];
    super(publicMessage);
    this.name = "PublicApiError";
    this.publicMessage = publicMessage;
  }
}

export function sanitizePublicError(error: unknown): string {
  return error instanceof PublicApiError
    ? error.publicMessage
    : "Internal server error";
}
