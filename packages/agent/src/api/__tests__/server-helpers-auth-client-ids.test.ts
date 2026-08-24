/**
 * Unit tests for server auth client ID normalization, terminal ID identification,
 * pairing code formatting, and boundary role resolution.
 */
import type http from "node:http";
import { describe, expect, it } from "vitest";
import {
  isSharedTerminalClientId,
  normalizePairingCode,
  normalizeWsClientId,
  resolveBoundaryRole,
  resolveTerminalRunClientId,
} from "../server-helpers-auth.ts";

describe("server-helpers-auth client id & pairing", () => {
  describe("normalizeWsClientId", () => {
    it("accepts valid alphanumeric, dot, underscore, and dash identifiers", () => {
      expect(normalizeWsClientId("client-123")).toBe("client-123");
      expect(normalizeWsClientId("user.session_456")).toBe("user.session_456");
      expect(normalizeWsClientId("  valid-trimmed-id  ")).toBe(
        "valid-trimmed-id",
      );
    });

    it("rejects empty or whitespace-only inputs", () => {
      expect(normalizeWsClientId("")).toBeNull();
      expect(normalizeWsClientId("   ")).toBeNull();
    });

    it("rejects non-string values", () => {
      expect(normalizeWsClientId(null)).toBeNull();
      expect(normalizeWsClientId(undefined)).toBeNull();
      expect(normalizeWsClientId(12345)).toBeNull();
      expect(normalizeWsClientId({})).toBeNull();
    });

    it("rejects characters outside the safe character class", () => {
      expect(normalizeWsClientId("client/with/slashes")).toBeNull();
      expect(normalizeWsClientId("client$injection")).toBeNull();
      expect(normalizeWsClientId("client<tag>")).toBeNull();
      expect(normalizeWsClientId("client;drop")).toBeNull();
    });

    it("rejects client IDs exceeding 128 characters", () => {
      const longId = "a".repeat(129);
      expect(normalizeWsClientId(longId)).toBeNull();
      const maxId = "a".repeat(128);
      expect(normalizeWsClientId(maxId)).toBe(maxId);
    });
  });

  describe("isSharedTerminalClientId", () => {
    it("identifies canonical shared terminal client IDs", () => {
      expect(isSharedTerminalClientId("runtime-terminal-action")).toBe(true);
      expect(isSharedTerminalClientId("runtime-shell-action")).toBe(true);
    });

    it("returns false for arbitrary client IDs", () => {
      expect(isSharedTerminalClientId("user-terminal-1")).toBe(false);
      expect(isSharedTerminalClientId("")).toBe(false);
    });
  });

  describe("normalizePairingCode", () => {
    it("strips dashes and punctuation and uppercases code", () => {
      expect(normalizePairingCode("abcd-efgh")).toBe("ABCDEFGH");
      expect(normalizePairingCode("1234-5678")).toBe("12345678");
      expect(normalizePairingCode("a-b_c.d 12")).toBe("ABCD12");
    });
  });

  describe("resolveTerminalRunClientId", () => {
    it("prefers valid X-Eliza-Client-Id header", () => {
      const req = {
        headers: {
          "x-eliza-client-id": "header-client-id",
        },
      } as unknown as Pick<http.IncomingMessage, "headers">;
      const body = { clientId: "body-client-id" };

      expect(resolveTerminalRunClientId(req, body)).toBe("header-client-id");
    });

    it("falls back to body.clientId when header is missing", () => {
      const req = {
        headers: {},
      } as unknown as Pick<http.IncomingMessage, "headers">;
      const body = { clientId: "body-client-id" };

      expect(resolveTerminalRunClientId(req, body)).toBe("body-client-id");
    });

    it("returns null when neither header nor body has a valid client ID", () => {
      const req = {
        headers: {},
      } as unknown as Pick<http.IncomingMessage, "headers">;
      expect(resolveTerminalRunClientId(req, null)).toBeNull();
      expect(
        resolveTerminalRunClientId(req, { clientId: "invalid/id" }),
      ).toBeNull();
    });
  });

  describe("resolveBoundaryRole", () => {
    it("resolves to GUEST when request is unauthorized", () => {
      const req = {
        headers: { host: "remote.example.com" },
        socket: { remoteAddress: "198.51.100.1" },
      } as unknown as http.IncomingMessage;
      expect(resolveBoundaryRole(req)).toBe("GUEST");
    });
  });
});
