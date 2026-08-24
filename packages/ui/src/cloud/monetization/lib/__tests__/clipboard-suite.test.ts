/**
 * Unit tests for monetization clipboard and referral invite URL builders.
 * Validates clipboard fallback mechanisms and referral URL formatting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReferralInviteLoginUrl,
  copyTextToClipboard,
} from "../clipboard.ts";

describe("monetization/lib/clipboard", () => {
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalDocument = globalThis.document;

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  describe("buildReferralInviteLoginUrl", () => {
    it("formats referral login URL without trailing slash on origin", () => {
      expect(
        buildReferralInviteLoginUrl("https://eliza.app", "INVITE123"),
      ).toBe("https://eliza.app/login?ref=INVITE123");
    });

    it("strips trailing slash from origin", () => {
      expect(buildReferralInviteLoginUrl("https://eliza.app/", "CODE456")).toBe(
        "https://eliza.app/login?ref=CODE456",
      );
    });

    it("URL-encodes special characters in referral code", () => {
      expect(
        buildReferralInviteLoginUrl("https://eliza.app", "MY CODE + BONUS"),
      ).toBe("https://eliza.app/login?ref=MY%20CODE%20%2B%20BONUS");
    });
  });

  describe("copyTextToClipboard", () => {
    it("returns false when window is undefined", async () => {
      Object.defineProperty(globalThis, "window", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      const result = await copyTextToClipboard("test");
      expect(result).toBe(false);
    });

    it("copies via navigator.clipboard.writeText when available", async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(globalThis, "window", {
        value: {},
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "navigator", {
        value: { clipboard: { writeText: writeTextMock } },
        configurable: true,
        writable: true,
      });

      const result = await copyTextToClipboard("https://eliza.app/invite");
      expect(result).toBe(true);
      expect(writeTextMock).toHaveBeenCalledWith("https://eliza.app/invite");
    });

    it("falls back to document.execCommand when navigator.clipboard.writeText throws", async () => {
      const writeTextMock = vi
        .fn()
        .mockRejectedValue(new Error("Permission denied"));
      const execCommandMock = vi.fn().mockReturnValue(true);
      const appendChildMock = vi.fn();
      const removeChildMock = vi.fn();

      Object.defineProperty(globalThis, "window", {
        value: {},
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "navigator", {
        value: { clipboard: { writeText: writeTextMock } },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "document", {
        value: {
          body: { appendChild: appendChildMock, removeChild: removeChildMock },
          createElement: vi.fn().mockReturnValue({
            setAttribute: vi.fn(),
            select: vi.fn(),
            style: {},
          }),
          execCommand: execCommandMock,
        },
        configurable: true,
        writable: true,
      });

      const result = await copyTextToClipboard("fallback-text");
      expect(result).toBe(true);
      expect(execCommandMock).toHaveBeenCalledWith("copy");
    });
  });
});
