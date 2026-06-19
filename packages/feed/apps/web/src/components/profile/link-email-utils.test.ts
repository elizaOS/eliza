import { describe, expect, it } from "bun:test";
import {
  getLinkedEmail,
  isLinkEmailAlreadyLinkedError,
  isLinkEmailFlowCancellationError,
} from "./link-email-utils";

describe("link-email-utils", () => {
  describe("getLinkedEmail", () => {
    it("prefers auth email when present", () => {
      expect(getLinkedEmail("linked@example.com", "stored@example.com")).toBe(
        "linked@example.com",
      );
    });

    it("falls back to stored email when auth email is missing", () => {
      expect(getLinkedEmail(undefined, "stored@example.com")).toBe(
        "stored@example.com",
      );
      expect(getLinkedEmail("   ", "stored@example.com")).toBe(
        "stored@example.com",
      );
    });

    it("returns null when neither source has an email", () => {
      expect(getLinkedEmail(undefined, undefined)).toBeNull();
      expect(getLinkedEmail(" ", " ")).toBeNull();
    });
  });

  describe("isLinkEmailFlowCancellationError", () => {
    it("detects the exited_auth_flow string code from useLinkAccount onError", () => {
      expect(isLinkEmailFlowCancellationError("exited_auth_flow")).toBe(true);
    });

    it("detects an auth error-shaped object with code exited_auth_flow", () => {
      const err = Object.assign(new Error("User exited link email flow"), {
        code: "exited_auth_flow",
      });
      expect(isLinkEmailFlowCancellationError(err)).toBe(true);
    });

    it("treats the Authentication cancelled message as a cancellation", () => {
      expect(isLinkEmailFlowCancellationError("Authentication cancelled")).toBe(
        true,
      );
    });

    it("returns false for unrelated primitive values", () => {
      expect(isLinkEmailFlowCancellationError("exited")).toBe(false);
      expect(isLinkEmailFlowCancellationError(null)).toBe(false);
      expect(isLinkEmailFlowCancellationError(42)).toBe(false);
    });

    it("returns false for plain Error without a matching code", () => {
      expect(
        isLinkEmailFlowCancellationError(new Error("Network failure")),
      ).toBe(false);
      const errWrongCode = Object.assign(new Error("other"), {
        code: "network_error",
      });
      expect(isLinkEmailFlowCancellationError(errWrongCode)).toBe(false);
    });
  });

  describe("isLinkEmailAlreadyLinkedError", () => {
    it("detects the cannot_link_more_of_type string code from useLinkAccount onError", () => {
      expect(isLinkEmailAlreadyLinkedError("cannot_link_more_of_type")).toBe(
        true,
      );
    });

    it("detects Error instances that expose an auth error code", () => {
      const err = Object.assign(new Error("Email already linked"), {
        authErrorCode: "cannot_link_more_of_type",
      });

      expect(isLinkEmailAlreadyLinkedError(err)).toBe(true);
    });

    it("returns false for other error codes", () => {
      expect(isLinkEmailAlreadyLinkedError("exited_auth_flow")).toBe(false);
      expect(isLinkEmailAlreadyLinkedError(new Error("Network failure"))).toBe(
        false,
      );
    });
  });
});
