import { describe, expect, it } from "bun:test";
import {
  AUTH_LOGIN_ERROR_MESSAGES,
  getAuthErrorMessage,
  getAuthLoginErrorMessage,
  isAuthFlowCancellationError,
  isAuthLinkFlowCancellationError,
  isAuthTwitterLinkConflictError,
} from "./auth-link-account-errors";

describe("auth-link-account-errors", () => {
  describe("getAuthErrorMessage", () => {
    it("extracts a string message from an Error instance", () => {
      expect(getAuthErrorMessage(new Error("Failed to connect to MetaMask"))).toBe(
        "Failed to connect to MetaMask",
      );
    });

    it("returns null for values without a string message", () => {
      expect(getAuthErrorMessage({ code: "exited_auth_flow" })).toBeNull();
      expect(getAuthErrorMessage(null)).toBeNull();
    });
  });

  describe("isAuthFlowCancellationError", () => {
    it("detects known cancellation codes and messages", () => {
      expect(isAuthFlowCancellationError("exited_auth_flow")).toBe(true);
      expect(isAuthFlowCancellationError("Authentication cancelled")).toBe(true);
      expect(
        isAuthFlowCancellationError(new Error("Authentication cancelled")),
      ).toBe(true);
      expect(
        isAuthFlowCancellationError({
          code: "exited_link_flow",
          message: "User exited link account flow",
        }),
      ).toBe(true);
    });
  });

  describe("isAuthLinkFlowCancellationError", () => {
    it("detects link flow cancellation shapes", () => {
      expect(isAuthLinkFlowCancellationError("exited_auth_flow")).toBe(true);
      expect(isAuthLinkFlowCancellationError("Proposal expired")).toBe(true);
      expect(
        isAuthLinkFlowCancellationError(new Error("Proposal expired")),
      ).toBe(true);
      expect(
        isAuthLinkFlowCancellationError({
          code: "exited_link_flow",
          message: "User exited link account flow",
        }),
      ).toBe(true);
    });

    it("returns false for other values", () => {
      expect(isAuthLinkFlowCancellationError("exited")).toBe(false);
      expect(isAuthLinkFlowCancellationError(null)).toBe(false);
      expect(
        isAuthLinkFlowCancellationError({
          code: "network_error",
          message: "Network failure",
        }),
      ).toBe(false);
    });
  });

  describe("isAuthTwitterLinkConflictError", () => {
    it("detects the twitter conflict error message", () => {
      expect(
        isAuthTwitterLinkConflictError(
          new Error("User already has an account of type twitter linked."),
        ),
      ).toBe(true);
      expect(
        isAuthTwitterLinkConflictError(
          "User already has an account of type twitter linked.",
        ),
      ).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      expect(
        isAuthTwitterLinkConflictError(
          new Error("Failed to link account. Please try again."),
        ),
      ).toBe(false);
      expect(isAuthTwitterLinkConflictError(null)).toBe(false);
    });
  });

  describe("getAuthLoginErrorMessage", () => {
    it("maps the MetaMask connection failure to a user-safe message", () => {
      expect(
        getAuthLoginErrorMessage(new Error("Failed to connect to MetaMask")),
      ).toBe(AUTH_LOGIN_ERROR_MESSAGES.METAMASK);
    });

    it("falls back to a generic message for other login failures", () => {
      expect(getAuthLoginErrorMessage(new Error("Wallet provider timeout"))).toBe(
        AUTH_LOGIN_ERROR_MESSAGES.DEFAULT,
      );
      expect(getAuthLoginErrorMessage(null)).toBe(
        AUTH_LOGIN_ERROR_MESSAGES.DEFAULT,
      );
    });
  });
});
