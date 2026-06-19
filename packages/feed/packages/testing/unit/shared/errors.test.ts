/**
 * Error Classes Unit Tests
 * Tests for shared error classes and error handling utilities
 */

import { describe, expect, it } from "bun:test";
import {
  AuthenticationError,
  AuthorizationError,
  BadRequestError,
  BusinessLogicError,
  ConflictError,
  DatabaseError,
  ExternalServiceError,
  InsufficientFundsError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  TradingError,
  ValidationError,
} from "@feed/shared";

describe("Error Classes", () => {
  describe("FeedError base class", () => {
    it("should have correct properties", () => {
      const error = new ValidationError("Test error", ["field1"]);
      expect(error.message).toBe("Test error");
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.statusCode).toBe(400);
      expect(error.isOperational).toBe(true);
      expect(error.timestamp).toBeInstanceOf(Date);
    });

    it("should serialize to JSON correctly", () => {
      const error = new NotFoundError("User", "123");
      const json = error.toJSON();

      expect(json.name).toBe("NotFoundError");
      expect(json.message).toBe("User not found: 123");
      expect(json.code).toBe("NOT_FOUND");
      expect(json.statusCode).toBe(404);
      expect(json.timestamp).toBeInstanceOf(Date);
    });
  });

  describe("ValidationError", () => {
    it("should include field information", () => {
      const error = new ValidationError("Invalid input", ["email", "password"]);
      expect(error.fields).toEqual(["email", "password"]);
    });

    it("should include violations", () => {
      const violations = [
        { field: "email", message: "Invalid email format" },
        { field: "password", message: "Too short" },
      ];
      const error = new ValidationError(
        "Validation failed",
        undefined,
        violations,
      );
      expect(error.violations).toEqual(violations);
    });
  });

  describe("AuthenticationError", () => {
    it("should include reason", () => {
      const error = new AuthenticationError("Token expired", "EXPIRED_TOKEN");
      expect(error.reason).toBe("EXPIRED_TOKEN");
      expect(error.code).toBe("AUTH_EXPIRED_TOKEN");
      expect(error.statusCode).toBe(401);
    });

    it("should support all reason types", () => {
      const reasons = [
        "NO_TOKEN",
        "INVALID_TOKEN",
        "EXPIRED_TOKEN",
        "INVALID_CREDENTIALS",
      ] as const;
      for (const reason of reasons) {
        const error = new AuthenticationError("Test", reason);
        expect(error.reason).toBe(reason);
      }
    });
  });

  describe("AuthorizationError", () => {
    it("should include resource and action", () => {
      const error = new AuthorizationError("Not allowed", "user", "delete");
      expect(error.resource).toBe("user");
      expect(error.action).toBe("delete");
      expect(error.statusCode).toBe(403);
    });
  });

  describe("NotFoundError", () => {
    it("should format message with identifier", () => {
      const error = new NotFoundError("User", "123");
      expect(error.message).toBe("User not found: 123");
    });

    it("should support custom message", () => {
      const error = new NotFoundError(
        "User",
        "123",
        "Custom not found message",
      );
      expect(error.message).toBe("Custom not found message");
    });

    it("should handle missing identifier", () => {
      const error = new NotFoundError("User");
      expect(error.message).toBe("User not found");
    });
  });

  describe("ConflictError", () => {
    it("should include conflicting resource", () => {
      const error = new ConflictError("Resource already exists", "email");
      expect(error.conflictingResource).toBe("email");
      expect(error.statusCode).toBe(409);
    });
  });

  describe("DatabaseError", () => {
    it("should include operation", () => {
      const error = new DatabaseError("Query failed", "SELECT");
      expect(error.operation).toBe("SELECT");
      expect(error.statusCode).toBe(500);
    });

    it("should include original error info", () => {
      const originalError = new Error("Connection lost");
      const error = new DatabaseError("Query failed", "INSERT", originalError);
      expect(error.context?.originalError).toBe("Connection lost");
    });
  });

  describe("ExternalServiceError", () => {
    it("should format message with service name", () => {
      const error = new ExternalServiceError("API", "Connection timeout", 504);
      expect(error.message).toBe("API: Connection timeout");
      expect(error.originalStatusCode).toBe(504);
      expect(error.statusCode).toBe(502);
    });
  });

  describe("RateLimitError", () => {
    it("should include rate limit info", () => {
      const error = new RateLimitError(100, 60000, 30);
      expect(error.limit).toBe(100);
      expect(error.windowMs).toBe(60000);
      expect(error.retryAfter).toBe(30);
      expect(error.statusCode).toBe(429);
    });
  });

  describe("BusinessLogicError", () => {
    it("should allow custom code and context", () => {
      const error = new BusinessLogicError("Custom error", "CUSTOM_CODE", {
        customField: "value",
      });
      expect(error.code).toBe("CUSTOM_CODE");
      expect(error.context?.customField).toBe("value");
    });
  });

  describe("Domain-specific errors", () => {
    it("InsufficientFundsError should include amounts", () => {
      const error = new InsufficientFundsError(100, 50, "USD");
      expect(error.required).toBe(100);
      expect(error.available).toBe(50);
      expect(error.currency).toBe("USD");
      expect(error.code).toBe("INSUFFICIENT_FUNDS");
    });

    it("TradingError should include market info", () => {
      const error = new TradingError(
        "Market closed",
        "BTC-USD",
        "MARKET_CLOSED",
      );
      expect(error.marketId).toBe("BTC-USD");
      expect(error.reason).toBe("MARKET_CLOSED");
      expect(error.code).toBe("TRADING_MARKET_CLOSED");
    });
  });

  describe("HTTP error classes", () => {
    it("BadRequestError should have 400 status", () => {
      const error = new BadRequestError("Invalid request");
      expect(error.statusCode).toBe(400);
    });

    it("InternalServerError should have 500 status and be non-operational", () => {
      const error = new InternalServerError("Server error");
      expect(error.statusCode).toBe(500);
      expect(error.isOperational).toBe(false);
    });

    it("ServiceUnavailableError should have 503 status", () => {
      const error = new ServiceUnavailableError("Service down", 60);
      expect(error.statusCode).toBe(503);
      expect(error.retryAfter).toBe(60);
    });
  });
});
