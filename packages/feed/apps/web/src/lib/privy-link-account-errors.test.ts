import { describe, expect, it } from "bun:test";
import {
  getPrivyErrorMessage,
  getPrivyLoginErrorMessage,
  isPrivyAuthFlowCancellationError,
  isPrivyLinkFlowCancellationError,
  isPrivyTwitterLinkConflictError,
  PRIVY_LOGIN_ERROR_MESSAGES,
  X_ACCOUNT_ALREADY_LINKED_MESSAGE,
} from "./privy-link-account-errors";

describe("privy-link-account-errors", () => {
  describe("getPrivyErrorMessage", () => {
    it("extracts a string message from an Error instance", () => {
      expect(
        getPrivyErrorMessage(new Error("Failed to connect to MetaMask")),
      ).toBe("Failed to connect to MetaMask");
    });

    it("returns null for values without a string message", () => {
      expect(getPrivyErrorMessage({ code: "exited_auth_flow" })).toBeNull();
      expect(getPrivyErrorMessage(null)).toBeNull();
    });
  });

  describe("isPrivyAuthFlowCancellationError", () => {
    it("detects the exited_auth_flow string code", () => {
      expect(isPrivyAuthFlowCancellationError("exited_auth_flow")).toBe(true);
    });

    it("treats the Authentication cancelled message as a user cancellation", () => {
      expect(isPrivyAuthFlowCancellationError("Authentication cancelled")).toBe(
        true,
      );
      expect(
        isPrivyAuthFlowCancellationError(new Error("Authentication cancelled")),
      ).toBe(true);
    });

    it("detects a PrivyClientError-shaped object with code exited_link_flow", () => {
      expect(
        isPrivyAuthFlowCancellationError({
          code: "exited_link_flow",
          message: "User exited link account flow",
        }),
      ).toBe(true);
    });
  });

  describe("isPrivyLinkFlowCancellationError", () => {
    it("detects the exited_auth_flow string code from useLinkAccount onError", () => {
      expect(isPrivyLinkFlowCancellationError("exited_auth_flow")).toBe(true);
    });

    it("treats the Authentication cancelled message as a user cancellation", () => {
      expect(isPrivyLinkFlowCancellationError("Authentication cancelled")).toBe(
        true,
      );
      expect(
        isPrivyLinkFlowCancellationError(new Error("Authentication cancelled")),
      ).toBe(true);
    });

    it("treats WalletConnect proposal expiry as a handled cancellation", () => {
      expect(isPrivyLinkFlowCancellationError("Proposal expired")).toBe(true);
      expect(
        isPrivyLinkFlowCancellationError(new Error("Proposal expired")),
      ).toBe(true);
    });

    it("detects the exited_link_flow string code from useLinkAccount onError", () => {
      expect(isPrivyLinkFlowCancellationError("exited_link_flow")).toBe(true);
    });

    it("detects a PrivyClientError-shaped object with code exited_auth_flow", () => {
      expect(
        isPrivyLinkFlowCancellationError({
          code: "exited_auth_flow",
          message: "User exited link email flow",
        }),
      ).toBe(true);
    });

    it("detects a PrivyClientError-shaped object with code exited_link_flow", () => {
      expect(
        isPrivyLinkFlowCancellationError({
          code: "exited_link_flow",
          message: "User exited link account flow",
        }),
      ).toBe(true);
    });

    it("returns false for other values", () => {
      expect(isPrivyLinkFlowCancellationError("exited")).toBe(false);
      expect(isPrivyLinkFlowCancellationError(null)).toBe(false);
      expect(
        isPrivyLinkFlowCancellationError({
          code: "network_error",
          message: "Network failure",
        }),
      ).toBe(false);
    });
  });

  describe("isPrivyTwitterLinkConflictError", () => {
    it("detects the Privy twitter conflict error message", () => {
      expect(
        isPrivyTwitterLinkConflictError(
          new Error("User already has an account of type twitter linked."),
        ),
      ).toBe(true);
    });

    it("handles the message when passed as a string", () => {
      expect(
        isPrivyTwitterLinkConflictError(
          "User already has an account of type twitter linked.",
        ),
      ).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      expect(
        isPrivyTwitterLinkConflictError(
          new Error("Failed to link account. Please try again."),
        ),
      ).toBe(false);
      expect(isPrivyTwitterLinkConflictError(null)).toBe(false);
    });
  });

  describe("getPrivyLoginErrorMessage", () => {
    it("maps the MetaMask connection failure to a user-safe message", () => {
      expect(
        getPrivyLoginErrorMessage(new Error("Failed to connect to MetaMask")),
      ).toBe(PRIVY_LOGIN_ERROR_MESSAGES.METAMASK);
    });

    it("falls back to a generic message for other login failures", () => {
      expect(
        getPrivyLoginErrorMessage(new Error("Wallet provider timeout")),
      ).toBe(PRIVY_LOGIN_ERROR_MESSAGES.DEFAULT);
      expect(getPrivyLoginErrorMessage(null)).toBe(
        PRIVY_LOGIN_ERROR_MESSAGES.DEFAULT,
      );
    });
  });

  it("exports the handled X conflict toast message", () => {
    expect(X_ACCOUNT_ALREADY_LINKED_MESSAGE).toBe(
      "This X account is already linked to another user",
    );
  });
});
