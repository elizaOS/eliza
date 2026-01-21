import { describe, expect, it } from "bun:test";
import {
  ApiError,
  AuthenticationError,
  AuthorizationError,
  BadRequestError,
  BusinessLogicError,
  ConflictError,
  createErrorResponse,
  ErrorCodes,
  InternalServerError,
  isAuthenticationError,
  isAuthorizationError,
  isOperationalError,
  isPolyagentError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  ValidationError,
} from "../errors";

describe("Error Classes", () => {
  describe("ApiError", () => {
    it("creates error with default status code", () => {
      const error = new ApiError("test error");
      expect(error.message).toBe("test error");
      expect(error.statusCode).toBe(500);
      expect(error.code).toBeUndefined();
    });

    it("creates error with custom status code and code", () => {
      const error = new ApiError("bad request", 400, "BAD_REQUEST");
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("BAD_REQUEST");
    });
  });

  describe("AuthenticationError", () => {
    it("creates error with default message", () => {
      const error = new AuthenticationError();
      expect(error.message).toBe("Authentication required");
      expect(error.code).toBe("AUTH_FAILED");
      expect(error.statusCode).toBe(401);
      expect(error.isOperational).toBe(true);
    });

    it("creates error with custom message and context", () => {
      const error = new AuthenticationError("Token expired", {
        userId: "test",
      });
      expect(error.message).toBe("Token expired");
      expect(error.context).toEqual({ userId: "test" });
    });
  });

  describe("AuthorizationError", () => {
    it("creates error with default message", () => {
      const error = new AuthorizationError();
      expect(error.message).toBe("Access denied");
      expect(error.code).toBe("FORBIDDEN");
      expect(error.statusCode).toBe(403);
    });

    it("creates error with resource and action", () => {
      const error = new AuthorizationError(
        "Cannot delete post",
        "post",
        "delete",
      );
      expect(error.resource).toBe("post");
      expect(error.action).toBe("delete");
    });
  });

  describe("BadRequestError", () => {
    it("creates error with 400 status", () => {
      const error = new BadRequestError("Invalid input");
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("BAD_REQUEST");
    });
  });

  describe("NotFoundError", () => {
    it("creates error with resource name", () => {
      const error = new NotFoundError("User");
      expect(error.message).toBe("User not found");
      expect(error.statusCode).toBe(404);
      expect(error.code).toBe("NOT_FOUND");
    });
  });

  describe("ConflictError", () => {
    it("creates error with 409 status", () => {
      const error = new ConflictError("Resource already exists");
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe("CONFLICT");
    });
  });

  describe("ValidationError", () => {
    it("creates error with validation errors", () => {
      const error = new ValidationError("Validation failed", {
        email: ["Invalid email format"],
        password: ["Too short", "Must contain number"],
      });
      expect(error.statusCode).toBe(422);
      expect(error.errors).toEqual({
        email: ["Invalid email format"],
        password: ["Too short", "Must contain number"],
      });
    });
  });

  describe("RateLimitError", () => {
    it("creates error with reset time", () => {
      const resetTime = Date.now() + 60000;
      const error = new RateLimitError("Too many requests", resetTime);
      expect(error.statusCode).toBe(429);
      expect(error.reset).toBe(resetTime);
    });
  });

  describe("InternalServerError", () => {
    it("creates non-operational error", () => {
      const error = new InternalServerError("Database connection failed");
      expect(error.statusCode).toBe(500);
      expect(error.isOperational).toBe(false);
    });
  });

  describe("ServiceUnavailableError", () => {
    it("creates error with 503 status", () => {
      const error = new ServiceUnavailableError();
      expect(error.statusCode).toBe(503);
      expect(error.message).toBe("Service temporarily unavailable");
    });
  });

  describe("BusinessLogicError", () => {
    it("creates error with custom code", () => {
      const error = new BusinessLogicError(
        "Insufficient balance",
        "INSUFFICIENT_FUNDS",
        { balance: 100, required: 200 },
      );
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("INSUFFICIENT_FUNDS");
      expect(error.context).toEqual({ balance: 100, required: 200 });
    });
  });
});

describe("Type Guards", () => {
  describe("isAuthenticationError", () => {
    it("returns true for AuthenticationError", () => {
      const error = new AuthenticationError();
      expect(isAuthenticationError(error)).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(isAuthenticationError(new Error())).toBe(false);
      expect(isAuthenticationError(new AuthorizationError())).toBe(false);
      expect(isAuthenticationError(null)).toBe(false);
      expect(isAuthenticationError(undefined)).toBe(false);
    });
  });

  describe("isAuthorizationError", () => {
    it("returns true for AuthorizationError", () => {
      const error = new AuthorizationError();
      expect(isAuthorizationError(error)).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(isAuthorizationError(new AuthenticationError())).toBe(false);
    });
  });

  describe("isPolyagentError", () => {
    it("returns true for all PolyagentError subclasses", () => {
      expect(isPolyagentError(new AuthenticationError())).toBe(true);
      expect(isPolyagentError(new AuthorizationError())).toBe(true);
      expect(isPolyagentError(new BadRequestError("test"))).toBe(true);
      expect(isPolyagentError(new NotFoundError())).toBe(true);
      expect(isPolyagentError(new InternalServerError())).toBe(true);
    });

    it("returns false for non-PolyagentError", () => {
      expect(isPolyagentError(new Error())).toBe(false);
      expect(isPolyagentError(new ApiError("test"))).toBe(false);
      expect(isPolyagentError("string")).toBe(false);
      expect(isPolyagentError(null)).toBe(false);
    });
  });

  describe("isOperationalError", () => {
    it("returns true for operational errors", () => {
      expect(isOperationalError(new AuthenticationError())).toBe(true);
      expect(isOperationalError(new BadRequestError("test"))).toBe(true);
      expect(isOperationalError(new RateLimitError())).toBe(true);
    });

    it("returns false for non-operational errors", () => {
      expect(isOperationalError(new InternalServerError())).toBe(false);
    });

    it("returns false for non-PolyagentError", () => {
      expect(isOperationalError(new Error())).toBe(false);
    });
  });
});

describe("createErrorResponse", () => {
  it("creates basic error response", () => {
    const error = new BadRequestError("Invalid input", "INVALID_INPUT");
    const response = createErrorResponse(error);

    expect(response).toEqual({
      error: {
        message: "Invalid input",
        code: "INVALID_INPUT",
      },
    });
  });

  it("includes validation violations for ValidationError", () => {
    const error = new ValidationError("Validation failed", {
      email: ["Invalid format"],
      name: ["Required", "Too short"],
    });
    const response = createErrorResponse(error);

    expect(response.error.violations).toEqual([
      { field: "email", message: "Invalid format" },
      { field: "name", message: "Required" },
      { field: "name", message: "Too short" },
    ]);
  });
});

describe("ErrorCodes", () => {
  it("has all expected error codes", () => {
    expect(ErrorCodes.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(ErrorCodes.NOT_FOUND).toBe("NOT_FOUND");
    expect(ErrorCodes.AUTH_NO_TOKEN).toBe("AUTH_NO_TOKEN");
    expect(ErrorCodes.RATE_LIMIT).toBe("RATE_LIMIT");
    expect(ErrorCodes.BLOCKCHAIN_ERROR).toBe("BLOCKCHAIN_ERROR");
  });
});
