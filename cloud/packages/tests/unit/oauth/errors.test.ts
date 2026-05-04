/**
 * OAuth Errors Unit Tests
 *
 * Tests error classes, factory functions, HTTP status mapping, and response formatting.
 */

import { describe, expect, it } from "bun:test";
import {
  ERROR_STATUS_MAP,
  Errors,
  internalErrorResponse,
  OAuthError,
  OAuthErrorCode,
  validationErrorResponse,
} from "@/lib/services/oauth/errors";

describe("OAuthError Class", () => {
  describe("constructor", () => {
    it("should create error with required parameters", () => {
      const error = new OAuthError(OAuthErrorCode.CONNECTION_NOT_FOUND, "Connection not found");

      expect(error.code).toBe(OAuthErrorCode.CONNECTION_NOT_FOUND);
      expect(error.message).toBe("Connection not found");
      expect(error.reconnectRequired).toBe(false);
      expect(error.retryAfter).toBeUndefined();
      expect(error.authUrl).toBeUndefined();
      expect(error.name).toBe("OAuthError");
    });

    it("should create error with all parameters", () => {
      const error = new OAuthError(
        OAuthErrorCode.RATE_LIMITED,
        "Rate limited",
        true,
        60,
        "https://auth.example.com",
      );

      expect(error.code).toBe(OAuthErrorCode.RATE_LIMITED);
      expect(error.message).toBe("Rate limited");
      expect(error.reconnectRequired).toBe(true);
      expect(error.retryAfter).toBe(60);
      expect(error.authUrl).toBe("https://auth.example.com");
    });

    it("should extend Error class", () => {
      const error = new OAuthError(OAuthErrorCode.INTERNAL_ERROR, "Test error");

      expect(error instanceof Error).toBe(true);
      expect(error instanceof OAuthError).toBe(true);
    });
  });

  describe("toResponse", () => {
    it("should convert to response object with all fields", () => {
      const error = new OAuthError(
        OAuthErrorCode.TOKEN_REFRESH_FAILED,
        "Token refresh failed",
        true,
        30,
        "https://auth.example.com",
      );

      const response = error.toResponse();

      expect(response.error).toBe("TOKEN_REFRESH_FAILED");
      expect(response.code).toBe(OAuthErrorCode.TOKEN_REFRESH_FAILED);
      expect(response.message).toBe("Token refresh failed");
      expect(response.reconnectRequired).toBe(true);
      expect(response.retryAfter).toBe(30);
      expect(response.authUrl).toBe("https://auth.example.com");
    });

    it("should convert to response with undefined optional fields", () => {
      const error = new OAuthError(OAuthErrorCode.UNAUTHORIZED, "Not authorized");

      const response = error.toResponse();

      expect(response.error).toBe("UNAUTHORIZED");
      expect(response.code).toBe(OAuthErrorCode.UNAUTHORIZED);
      expect(response.message).toBe("Not authorized");
      expect(response.reconnectRequired).toBe(false);
      expect(response.retryAfter).toBeUndefined();
      expect(response.authUrl).toBeUndefined();
    });
  });

  describe("httpStatus", () => {
    it("should return correct HTTP status for each error code", () => {
      const expectedStatuses: Record<OAuthErrorCode, number> = {
        [OAuthErrorCode.CONNECTION_NOT_FOUND]: 404,
        [OAuthErrorCode.PLATFORM_NOT_CONNECTED]: 401,
        [OAuthErrorCode.CONNECTION_REVOKED]: 401,
        [OAuthErrorCode.CONNECTION_EXPIRED]: 401,
        [OAuthErrorCode.TOKEN_REFRESH_FAILED]: 401,
        [OAuthErrorCode.TOKEN_DECRYPTION_FAILED]: 401,
        [OAuthErrorCode.TOKEN_INVALID]: 401,
        [OAuthErrorCode.PLATFORM_NOT_CONFIGURED]: 400,
        [OAuthErrorCode.PLATFORM_NOT_SUPPORTED]: 400,
        [OAuthErrorCode.INVALID_SCOPE_REQUEST]: 400,
        [OAuthErrorCode.UNAUTHORIZED]: 401,
        [OAuthErrorCode.FORBIDDEN]: 403,
        [OAuthErrorCode.RATE_LIMITED]: 429,
        [OAuthErrorCode.INTERNAL_ERROR]: 500,
      };

      for (const [code, expectedStatus] of Object.entries(expectedStatuses)) {
        const error = new OAuthError(code as OAuthErrorCode, "Test");
        expect(error.httpStatus).toBe(expectedStatus);
      }
    });
  });
});

describe("ERROR_STATUS_MAP", () => {
  it("should have all error codes mapped", () => {
    const allCodes = Object.values(OAuthErrorCode);

    for (const code of allCodes) {
      expect(ERROR_STATUS_MAP[code]).toBeDefined();
      expect(typeof ERROR_STATUS_MAP[code]).toBe("number");
    }
  });

  it("should map to valid HTTP status codes", () => {
    for (const status of Object.values(ERROR_STATUS_MAP)) {
      expect(status).toBeGreaterThanOrEqual(100);
      expect(status).toBeLessThan(600);
    }
  });
});

describe("Error Factory Functions", () => {
  describe("Errors.platformNotConnected", () => {
    it("should create error with platform name", () => {
      const error = Errors.platformNotConnected("google");

      expect(error.code).toBe(OAuthErrorCode.PLATFORM_NOT_CONNECTED);
      expect(error.message).toContain("google");
      expect(error.reconnectRequired).toBe(true);
    });

    it("should work with various platform names", () => {
      const platforms = ["twitter", "twilio", "blooio", "custom"];

      for (const platform of platforms) {
        const error = Errors.platformNotConnected(platform);
        expect(error.message).toContain(platform);
      }
    });
  });

  describe("Errors.connectionNotFound", () => {
    it("should create error with connection ID", () => {
      const error = Errors.connectionNotFound("abc-123");

      expect(error.code).toBe(OAuthErrorCode.CONNECTION_NOT_FOUND);
      expect(error.message).toContain("abc-123");
      expect(error.reconnectRequired).toBe(false);
    });
  });

  describe("Errors.connectionRevoked", () => {
    it("should create error with platform name", () => {
      const error = Errors.connectionRevoked("Twitter");

      expect(error.code).toBe(OAuthErrorCode.CONNECTION_REVOKED);
      expect(error.message).toContain("Twitter");
      expect(error.reconnectRequired).toBe(true);
    });
  });

  describe("Errors.connectionExpired", () => {
    it("should create error with platform name", () => {
      const error = Errors.connectionExpired("Google");

      expect(error.code).toBe(OAuthErrorCode.CONNECTION_EXPIRED);
      expect(error.message).toContain("Google");
      expect(error.reconnectRequired).toBe(true);
    });
  });

  describe("Errors.tokenRefreshFailed", () => {
    it("should create error without reason", () => {
      const error = Errors.tokenRefreshFailed("Google");

      expect(error.code).toBe(OAuthErrorCode.TOKEN_REFRESH_FAILED);
      expect(error.message).toContain("Google");
      expect(error.reconnectRequired).toBe(true);
    });

    it("should create error with reason", () => {
      const error = Errors.tokenRefreshFailed("Google", "Invalid refresh token");

      expect(error.message).toContain("Google");
      expect(error.message).toContain("Invalid refresh token");
    });
  });

  describe("Errors.tokenDecryptionFailed", () => {
    it("should create error with platform name", () => {
      const error = Errors.tokenDecryptionFailed("Twitter");

      expect(error.code).toBe(OAuthErrorCode.TOKEN_DECRYPTION_FAILED);
      expect(error.message).toContain("Twitter");
      expect(error.reconnectRequired).toBe(true);
    });
  });

  describe("Errors.tokenInvalid", () => {
    it("should create error with platform name", () => {
      const error = Errors.tokenInvalid("Twilio");

      expect(error.code).toBe(OAuthErrorCode.TOKEN_INVALID);
      expect(error.message).toContain("Twilio");
      expect(error.reconnectRequired).toBe(true);
    });
  });

  describe("Errors.platformNotConfigured", () => {
    it("should create error with platform name", () => {
      const error = Errors.platformNotConfigured("Discord");

      expect(error.code).toBe(OAuthErrorCode.PLATFORM_NOT_CONFIGURED);
      expect(error.message).toContain("Discord");
      expect(error.reconnectRequired).toBe(false);
    });
  });

  describe("Errors.platformNotSupported", () => {
    it("should create error with platform name", () => {
      const error = Errors.platformNotSupported("unknown");

      expect(error.code).toBe(OAuthErrorCode.PLATFORM_NOT_SUPPORTED);
      expect(error.message).toContain("unknown");
      expect(error.reconnectRequired).toBe(false);
    });
  });

  describe("Errors.unauthorized", () => {
    it("should create unauthorized error", () => {
      const error = Errors.unauthorized();

      expect(error.code).toBe(OAuthErrorCode.UNAUTHORIZED);
      expect(error.reconnectRequired).toBe(false);
    });
  });

  describe("Errors.forbidden", () => {
    it("should create forbidden error", () => {
      const error = Errors.forbidden();

      expect(error.code).toBe(OAuthErrorCode.FORBIDDEN);
      expect(error.reconnectRequired).toBe(false);
    });
  });

  describe("Errors.rateLimited", () => {
    it("should create rate limited error with retry after", () => {
      const error = Errors.rateLimited(120);

      expect(error.code).toBe(OAuthErrorCode.RATE_LIMITED);
      expect(error.retryAfter).toBe(120);
      expect(error.message).toContain("120");
      expect(error.reconnectRequired).toBe(false);
    });
  });

  describe("Errors.internalError", () => {
    it("should create internal error with message", () => {
      const error = Errors.internalError("Database connection failed");

      expect(error.code).toBe(OAuthErrorCode.INTERNAL_ERROR);
      expect(error.message).toBe("Database connection failed");
      expect(error.reconnectRequired).toBe(false);
    });
  });
});

describe("Response Helper Functions", () => {
  describe("internalErrorResponse", () => {
    it("should create response with default message", () => {
      const response = internalErrorResponse();

      expect(response.error).toBe("INTERNAL_ERROR");
      expect(response.code).toBe(OAuthErrorCode.INTERNAL_ERROR);
      expect(response.message).toBe("An unexpected error occurred");
      expect(response.reconnectRequired).toBe(false);
    });

    it("should create response with custom message", () => {
      const response = internalErrorResponse("Custom error message");

      expect(response.message).toBe("Custom error message");
    });
  });

  describe("validationErrorResponse", () => {
    it("should create validation error response", () => {
      const response = validationErrorResponse("Invalid platform");

      expect(response.error).toBe("VALIDATION_ERROR");
      expect(response.code).toBe(OAuthErrorCode.INTERNAL_ERROR);
      expect(response.message).toBe("Invalid platform");
      expect(response.reconnectRequired).toBe(false);
    });
  });
});

describe("OAuthErrorCode Enum", () => {
  it("should have unique values", () => {
    const values = Object.values(OAuthErrorCode);
    const uniqueValues = new Set(values);

    expect(values.length).toBe(uniqueValues.size);
  });

  it("should have all expected error codes", () => {
    const expectedCodes = [
      "PLATFORM_NOT_CONNECTED",
      "CONNECTION_NOT_FOUND",
      "CONNECTION_REVOKED",
      "CONNECTION_EXPIRED",
      "PLATFORM_NOT_CONFIGURED",
      "PLATFORM_NOT_SUPPORTED",
      "TOKEN_REFRESH_FAILED",
      "TOKEN_DECRYPTION_FAILED",
      "TOKEN_INVALID",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "RATE_LIMITED",
      "INTERNAL_ERROR",
    ];

    const values = Object.values(OAuthErrorCode) as string[];
    for (const code of expectedCodes) {
      expect(values).toContain(code);
    }
  });
});
