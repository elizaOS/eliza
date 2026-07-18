/** Stable OAuth-style error responses for the native App Auth boundary. */
import type { Context } from "hono";
import {
  MobileAppAuthProtocolError,
  type MobileAppAuthProtocolErrorCode,
} from "@/lib/services/mobile-app-auth";
import { logger } from "@/lib/utils/logger";

const STATUS_BY_CODE: Record<
  MobileAppAuthProtocolErrorCode,
  400 | 401 | 409 | 410 | 503
> = {
  authorization_code_expired: 410,
  authorization_complete: 409,
  binding_mismatch: 400,
  credential_proof_invalid: 401,
  invalid_authorization_code: 400,
  invalid_client: 401,
  invalid_code_verifier: 400,
  invalid_request: 400,
  server_configuration_error: 503,
};

export function mobileAppAuthErrorResponse(
  c: Context,
  error: unknown,
  operation: string,
): Response {
  if (error instanceof MobileAppAuthProtocolError) {
    logger.warn("[MobileAppAuth] Request rejected", {
      operation,
      errorCode: error.protocolCode,
    });
    return c.json(
      {
        success: false,
        error: error.protocolCode,
        errorDescription: error.message,
        retryable: false,
      },
      STATUS_BY_CODE[error.protocolCode],
    );
  }
  logger.error("[MobileAppAuth] Dependency failure", {
    operation,
    error: error instanceof Error ? error.message : String(error),
  });
  return c.json(
    {
      success: false,
      error: "temporarily_unavailable",
      errorDescription: "Mobile authorization is temporarily unavailable",
      retryable: true,
    },
    503,
  );
}
