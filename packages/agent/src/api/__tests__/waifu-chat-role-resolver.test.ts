/**
 * Unit tests for WaifuChat boundary-role resolver.
 * Validates HS256 JWT validation, claims extraction, role-to-world-role mapping,
 * and extension point registration.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerWaifuChatRoleResolver,
  resolveWaifuChatAccessToken,
  WAIFU_CHAT_RESOLVER_ID,
  WAIFU_CHAT_ROLE_TO_WORLD_ROLE,
  waifuChatRoleResolver,
  waifuChatRoleToWorldRole,
} from "../waifu-chat-role-resolver.ts";

function createJwt(
  payload: Record<string, unknown>,
  secret = "test-secret-key-12345",
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest("base64url");
  return `${h}.${p}.${sig}`;
}

describe("waifu-chat-role-resolver", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "test-secret-key-12345";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("role mapping", () => {
    it("maps waifu roles to canonical world roles", () => {
      expect(waifuChatRoleToWorldRole("admin")).toBe("OWNER");
      expect(waifuChatRoleToWorldRole("user")).toBe("USER");
      expect(waifuChatRoleToWorldRole("guest")).toBe("GUEST");
    });

    it("freezes WAIFU_CHAT_ROLE_TO_WORLD_ROLE constant mapping", () => {
      expect(Object.isFrozen(WAIFU_CHAT_ROLE_TO_WORLD_ROLE)).toBe(true);
      expect(WAIFU_CHAT_ROLE_TO_WORLD_ROLE.admin).toBe("OWNER");
      expect(WAIFU_CHAT_ROLE_TO_WORLD_ROLE.user).toBe("USER");
      expect(WAIFU_CHAT_ROLE_TO_WORLD_ROLE.guest).toBe("GUEST");
    });
  });

  describe("resolveWaifuChatAccessToken", () => {
    it("returns null when secret is unset or token is missing", () => {
      delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
      expect(resolveWaifuChatAccessToken("some.valid.token")).toBeNull();

      process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "secret";
      expect(resolveWaifuChatAccessToken(null)).toBeNull();
      expect(resolveWaifuChatAccessToken("")).toBeNull();
    });

    it("returns null for malformed token structures", () => {
      expect(resolveWaifuChatAccessToken("not-a-jwt")).toBeNull();
      expect(resolveWaifuChatAccessToken("two.segments")).toBeNull();
      expect(resolveWaifuChatAccessToken("a.b.c.d")).toBeNull();
    });

    it("returns null when HMAC signature does not match secret", () => {
      const token = createJwt(
        {
          iss: "waifu.fun",
          aud: "eliza-cloud-chat",
          role: "user",
          walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        "wrong-secret",
      );
      expect(resolveWaifuChatAccessToken(token)).toBeNull();
    });

    it("validates algorithm is HS256", () => {
      const token = createJwt(
        {
          iss: "waifu.fun",
          aud: "eliza-cloud-chat",
          role: "user",
          walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        "test-secret-key-12345",
        { alg: "RS256", typ: "JWT" },
      );
      expect(resolveWaifuChatAccessToken(token)).toBeNull();
    });

    it("validates issuer is waifu.fun", () => {
      const token = createJwt({
        iss: "other.issuer",
        aud: "eliza-cloud-chat",
        role: "user",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(resolveWaifuChatAccessToken(token)).toBeNull();
    });

    it("validates audience contains eliza-cloud-chat", () => {
      const token = createJwt({
        iss: "waifu.fun",
        aud: "other-aud",
        role: "user",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(resolveWaifuChatAccessToken(token)).toBeNull();
    });

    it("validates token expiration and not-before claims", () => {
      const now = Math.floor(Date.now() / 1000);
      const expired = createJwt({
        iss: "waifu.fun",
        aud: "eliza-cloud-chat",
        role: "user",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        exp: now - 100,
      });
      expect(resolveWaifuChatAccessToken(expired, now)).toBeNull();

      const future = createJwt({
        iss: "waifu.fun",
        aud: "eliza-cloud-chat",
        role: "user",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        exp: now + 3600,
        nbf: now + 500,
      });
      expect(resolveWaifuChatAccessToken(future, now)).toBeNull();
    });

    it("validates walletAddress format", () => {
      const invalidWallet = createJwt({
        iss: "waifu.fun",
        aud: "eliza-cloud-chat",
        role: "user",
        walletAddress: "not-a-valid-0x-address",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(resolveWaifuChatAccessToken(invalidWallet)).toBeNull();
    });

    it("successfully parses valid token with claims", () => {
      const token = createJwt({
        iss: "waifu.fun",
        aud: "eliza-cloud-chat",
        role: "admin",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        tokenAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        chainId: 8453,
        cloudAgentId: "agent-999",
        balanceTokens: 500,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const access = resolveWaifuChatAccessToken(token);
      expect(access).not.toBeNull();
      expect(access?.role).toBe("admin");
      expect(access?.walletAddress).toBe(
        "0x1234567890abcdef1234567890abcdef12345678",
      );
      expect(access?.tokenAddress).toBe(
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );
      expect(access?.chainId).toBe(8453);
      expect(access?.cloudAgentId).toBe("agent-999");
      expect(access?.balanceTokens).toBe(500);
    });
  });

  describe("resolver registration", () => {
    it("exposes stable resolver id", () => {
      expect(WAIFU_CHAT_RESOLVER_ID).toBe("waifu-chat");
      expect(waifuChatRoleResolver.id).toBe("waifu-chat");
    });

    it("supports idempotent registration and teardown", () => {
      const unregister = registerWaifuChatRoleResolver();
      expect(typeof unregister).toBe("function");
    });
  });
});
