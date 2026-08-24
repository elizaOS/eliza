/**
 * #12087 item 12 — WaifuChat parallel role scheme moved out of the trunk auth
 * helper into a boundary-role resolver the trunk consults through an extension
 * point.
 *
 * This suite proves three things:
 *  1. PARITY — the moved waifu token parsing, role→world-role mapping, and route
 *     allowlist behave byte-identically to the pre-refactor trunk helper (the
 *     original `waifu chat JWT auth` cases, carried over verbatim + a frozen
 *     mapping-table assertion).
 *  2. EXTENSION POINT — with no resolver registered the trunk gate resolves NO
 *     waifu access (proving the scheme is gone from trunk); registering the
 *     waifu resolver reconnects identical behaviour through the seam.
 *  3. GREP GUARD — the trunk auth helper source contains none of the waifu role
 *     vocabulary/parsing that moved (the old special-case gate is gone from the
 *     executable trunk path).
 */
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearTokenRoleResolvers,
  isRegisteredTokenRoleAuthorized,
  registerTokenRoleResolver,
  resolveRegisteredTokenRoleAccess,
} from "../../src/api/boundary-role-resolver";
import {
  isWaifuChatAuthorized,
  resolveWaifuChatAccessToken,
  WAIFU_CHAT_ROLE_TO_WORLD_ROLE,
  waifuChatRoleResolver,
  waifuChatRoleToWorldRole,
} from "../../src/api/waifu-chat-role-resolver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function signWaifuJwt(
  payload: Record<string, unknown>,
  secret = "waifu-secret",
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function requestWithBearer(token: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = {};
  req.headers.authorization = `Bearer ${token}`;
  req.headers.host = "agent.example";
  return req;
}

describe("waifu chat JWT auth (parity — moved verbatim from trunk)", () => {
  const futureExp = () => Math.floor(Date.now() / 1000) + 60;

  beforeEach(() => {
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "waifu-secret";
    process.env.TOKEN_CONTRACT_ADDRESS =
      "0x2222222222222222222222222222222222222222";
    process.env.TOKEN_CHAIN_ID = "56";
    delete process.env.WAIFU_ELIZA_CLOUD_AGENT_ID;
    delete process.env.ELIZA_CLOUD_AGENT_ID;
  });

  afterEach(() => {
    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
    delete process.env.TOKEN_CONTRACT_ADDRESS;
    delete process.env.TOKEN_CHAIN_ID;
    delete process.env.WAIFU_ELIZA_CLOUD_AGENT_ID;
    delete process.env.ELIZA_CLOUD_AGENT_ID;
  });

  it("verifies issuer, audience, expiry, signature, wallet, and token scope", () => {
    const token = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: 2_000,
      role: "user",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
      cloudAgentId: "cloud-agent-1",
      balanceTokens: 100_001,
    });

    expect(resolveWaifuChatAccessToken(token, 1_000)).toEqual({
      role: "user",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
      cloudAgentId: "cloud-agent-1",
      balanceTokens: 100_001,
    });

    expect(resolveWaifuChatAccessToken(`${token}tampered`, 1_000)).toBeNull();
    expect(resolveWaifuChatAccessToken(token, 2_001)).toBeNull();
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt({
          iss: "waifu.fun",
          aud: "eliza-cloud-chat",
          exp: 2_000,
          role: "user",
          walletAddress: "0x1111111111111111111111111111111111111111",
          tokenAddress: "0x3333333333333333333333333333333333333333",
          chainId: 56,
        }),
        1_000,
      ),
    ).toBeNull();
  });

  it("binds waifu chat JWTs to the hosted cloud agent id when configured", () => {
    process.env.WAIFU_ELIZA_CLOUD_AGENT_ID = "cloud-agent-1";
    const token = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "guest",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
      cloudAgentId: "cloud-agent-1",
    });

    expect(resolveWaifuChatAccessToken(token)?.cloudAgentId).toBe(
      "cloud-agent-1",
    );
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt({
          iss: "waifu.fun",
          aud: "eliza-cloud-chat",
          exp: futureExp(),
          role: "guest",
          walletAddress: "0x1111111111111111111111111111111111111111",
          tokenAddress: "0x2222222222222222222222222222222222222222",
          chainId: 56,
          cloudAgentId: "cloud-agent-2",
        }),
      ),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt({
          iss: "waifu.fun",
          aud: "eliza-cloud-chat",
          exp: futureExp(),
          role: "guest",
          walletAddress: "0x1111111111111111111111111111111111111111",
          tokenAddress: "0x2222222222222222222222222222222222222222",
          chainId: 56,
        }),
      ),
    ).toBeNull();
  });

  it("accepts waifu admin, user, and guest chat roles", () => {
    const cases = [
      { role: "admin", worldRole: "OWNER" },
      { role: "user", worldRole: "USER" },
      { role: "guest", worldRole: "GUEST" },
    ] as const;

    for (const { role, worldRole } of cases) {
      const token = signWaifuJwt({
        iss: "waifu.fun",
        aud: "eliza-cloud-chat",
        exp: futureExp(),
        role,
        walletAddress: "0x1111111111111111111111111111111111111111",
        tokenAddress: "0x2222222222222222222222222222222222222222",
        chainId: 56,
      });

      expect(resolveWaifuChatAccessToken(token)?.role).toBe(role);
      expect(waifuChatRoleToWorldRole(role)).toBe(worldRole);
    }
  });

  it("scopes guest and user JWTs to chat-safe routes while admin can use owner UI routes", () => {
    const guestToken = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "guest",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });
    const userToken = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "user",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });
    const adminToken = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "admin",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });

    expect(
      isWaifuChatAuthorized(
        requestWithBearer(guestToken),
        "POST",
        "/api/conversations/conv-1/messages/stream",
      ),
    ).toBe(true);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(userToken),
        "POST",
        "/api/conversations/conv-1/messages/stream",
      ),
    ).toBe(true);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(guestToken),
        "POST",
        "/api/config",
      ),
    ).toBe(false);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(userToken),
        "POST",
        "/api/config",
      ),
    ).toBe(false);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(adminToken),
        "POST",
        "/api/config",
      ),
    ).toBe(true);
  });

  it("freezes the waifu-role → world-role mapping table", () => {
    // The single source of truth for the waifu role scheme. If this table
    // changes, the parity guarantee with the pre-refactor trunk map is broken.
    expect(WAIFU_CHAT_ROLE_TO_WORLD_ROLE).toEqual({
      admin: "OWNER",
      user: "USER",
      guest: "GUEST",
    });
  });
});

describe("boundary-role extension point (#12087 item 12)", () => {
  const futureExp = () => Math.floor(Date.now() / 1000) + 60;

  const adminToken = () =>
    signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "admin",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });

  const userToken = () =>
    signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "user",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });

  beforeEach(() => {
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "waifu-secret";
    process.env.TOKEN_CONTRACT_ADDRESS =
      "0x2222222222222222222222222222222222222222";
    process.env.TOKEN_CHAIN_ID = "56";
    clearTokenRoleResolvers();
  });

  afterEach(() => {
    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
    delete process.env.TOKEN_CONTRACT_ADDRESS;
    delete process.env.TOKEN_CHAIN_ID;
    clearTokenRoleResolvers();
  });

  it("with NO resolver registered, the trunk gate resolves no waifu access (scheme removed from trunk)", () => {
    // Proves the special-case waifu gate is no longer baked into the trunk: a
    // valid waifu admin token is unrecognised by the registry-driven gate until
    // the waifu resolver is registered.
    expect(
      resolveRegisteredTokenRoleAccess(requestWithBearer(adminToken())),
    ).toBeNull();
    expect(
      isRegisteredTokenRoleAuthorized(
        requestWithBearer(adminToken()),
        "POST",
        "/api/config",
      ),
    ).toBe(false);
  });

  it("registering the waifu resolver reconnects identical role mapping + route scope through the seam", () => {
    registerTokenRoleResolver(waifuChatRoleResolver);

    const adminAccess = resolveRegisteredTokenRoleAccess(
      requestWithBearer(adminToken()),
    );
    expect(adminAccess).not.toBeNull();
    expect(adminAccess?.providerId).toBe("waifu-chat");
    expect(adminAccess?.worldRole).toBe("OWNER");
    expect(adminAccess?.isAdmin).toBe(true);
    expect(adminAccess?.principal).toBe(
      "0x1111111111111111111111111111111111111111",
    );

    const userAccess = resolveRegisteredTokenRoleAccess(
      requestWithBearer(userToken()),
    );
    expect(userAccess?.worldRole).toBe("USER");
    expect(userAccess?.isAdmin).toBe(false);

    // Admin: authorized everywhere. User: scoped to chat-safe routes only.
    expect(
      isRegisteredTokenRoleAuthorized(
        requestWithBearer(adminToken()),
        "POST",
        "/api/config",
      ),
    ).toBe(true);
    expect(
      isRegisteredTokenRoleAuthorized(
        requestWithBearer(userToken()),
        "POST",
        "/api/config",
      ),
    ).toBe(false);
    expect(
      isRegisteredTokenRoleAuthorized(
        requestWithBearer(userToken()),
        "POST",
        "/api/conversations/conv-1/messages/stream",
      ),
    ).toBe(true);
  });

  it("registry authorization matches the standalone isWaifuChatAuthorized (parity through the seam)", () => {
    registerTokenRoleResolver(waifuChatRoleResolver);
    const cases: Array<[ReturnType<typeof userToken>, string, string]> = [
      [adminToken(), "POST", "/api/config"],
      [userToken(), "POST", "/api/config"],
      [userToken(), "POST", "/api/conversations/conv-1/messages/stream"],
      [userToken(), "GET", "/api/conversations"],
      [userToken(), "DELETE", "/api/conversations/conv-1"],
    ];
    for (const [token, method, pathname] of cases) {
      expect(
        isRegisteredTokenRoleAuthorized(
          requestWithBearer(token),
          method,
          pathname,
        ),
      ).toBe(isWaifuChatAuthorized(requestWithBearer(token), method, pathname));
    }
  });
});

describe("grep guard: waifu role scheme is gone from the trunk auth helper", () => {
  const trunkSource = fs.readFileSync(
    path.resolve(__dirname, "../../src/api/server-helpers-auth.ts"),
    "utf8",
  );

  it.each([
    "resolveWaifuChatAccessToken",
    "resolveWaifuChatAccess",
    "waifuChatRoleToWorldRole",
    "isWaifuChatAuthorized",
    "isWaifuChatScopedRoute",
    "WaifuChatAccess",
    "WaifuChatRole",
    "WaifuChatWorldRole",
    "eliza-cloud-chat",
  ])(
    "trunk server-helpers-auth.ts no longer references the waifu role identifier %s",
    (identifier) => {
      expect(trunkSource).not.toContain(identifier);
    },
  );

  it("trunk no longer maps the admin/user/guest role literals to world roles", () => {
    // The mapping ladder (admin→OWNER etc.) must not exist in the trunk source.
    expect(trunkSource).not.toMatch(/role\s*===\s*"admin"/);
    expect(trunkSource).not.toMatch(/role\s*===\s*"guest"/);
  });
});

describe("waifu token gate edge cases (JWT claim validation)", () => {
  const NOW = 1_000;
  const wallet = "0x1111111111111111111111111111111111111111";
  const tokenAddress = "0x2222222222222222222222222222222222222222";

  const claims = (overrides: Record<string, unknown> = {}) => ({
    iss: "waifu.fun",
    aud: "eliza-cloud-chat",
    exp: 2_000,
    role: "guest",
    walletAddress: wallet,
    tokenAddress,
    chainId: 56,
    ...overrides,
  });

  beforeEach(() => {
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "waifu-secret";
    process.env.TOKEN_CONTRACT_ADDRESS = tokenAddress;
    process.env.TOKEN_CHAIN_ID = "56";
    delete process.env.WAIFU_ELIZA_CLOUD_AGENT_ID;
    delete process.env.ELIZA_CLOUD_AGENT_ID;
  });

  afterEach(() => {
    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
    delete process.env.TOKEN_CONTRACT_ADDRESS;
    delete process.env.TOKEN_CHAIN_ID;
    delete process.env.WAIFU_ELIZA_CLOUD_AGENT_ID;
    delete process.env.ELIZA_CLOUD_AGENT_ID;
  });

  it("accepts an aud array containing eliza-cloud-chat and rejects one without it", () => {
    const accepted = resolveWaifuChatAccessToken(
      signWaifuJwt(claims({ aud: ["other-scope", "eliza-cloud-chat"] })),
      NOW,
    );
    expect(accepted?.role).toBe("guest");

    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt(claims({ aud: ["other-scope"] })),
        NOW,
      ),
    ).toBeNull();
  });

  it("honours nbf: a not-yet-valid token is rejected while nbf at or before now is accepted", () => {
    expect(
      resolveWaifuChatAccessToken(signWaifuJwt(claims({ nbf: 1_001 })), NOW),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(signWaifuJwt(claims({ nbf: 1_000 })), NOW)
        ?.role,
    ).toBe("guest");
    expect(
      resolveWaifuChatAccessToken(signWaifuJwt(claims({ nbf: 900 })), NOW)
        ?.role,
    ).toBe("guest");
  });

  it("rejects exp exactly equal to the current second", () => {
    expect(
      resolveWaifuChatAccessToken(signWaifuJwt(claims({ exp: 1_000 })), NOW),
    ).toBeNull();
  });

  it("falls back to the sub claim for the wallet address when walletAddress is absent", () => {
    const fromSub = resolveWaifuChatAccessToken(
      signWaifuJwt(
        claims({
          walletAddress: undefined,
          sub: " 0xAABBCCDDEEFF00112233445566778899AABBCCDD ",
        }),
      ),
      NOW,
    );
    expect(fromSub?.walletAddress).toBe(
      "0xAABBCCDDEEFF00112233445566778899AABBCCDD",
    );

    const trimsWalletClaim = resolveWaifuChatAccessToken(
      signWaifuJwt(claims({ walletAddress: ` ${wallet} ` })),
      NOW,
    );
    expect(trimsWalletClaim?.walletAddress).toBe(wallet);
  });

  it("rejects wallet identities that are not 0x-prefixed 40-hex addresses", () => {
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt(claims({ walletAddress: undefined, sub: "0x1234" })),
        NOW,
      ),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt(
          claims({
            walletAddress: undefined,
            sub: "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
          }),
        ),
        NOW,
      ),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt(claims({ walletAddress: undefined, sub: undefined })),
        NOW,
      ),
    ).toBeNull();
  });

  it("enforces TOKEN_CHAIN_ID against the numeric chainId claim", () => {
    expect(
      resolveWaifuChatAccessToken(signWaifuJwt(claims({ chainId: 1 })), NOW),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(signWaifuJwt(claims({ chainId: "56" })), NOW),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt(claims({ chainId: undefined })),
        NOW,
      ),
    ).toBeNull();
    expect(resolveWaifuChatAccessToken(signWaifuJwt(claims()), NOW)?.role).toBe(
      "guest",
    );
  });

  it("rejects tokens when the configured secret is missing or whitespace-only", () => {
    const token = signWaifuJwt(claims());
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "   ";
    expect(resolveWaifuChatAccessToken(token, NOW)).toBeNull();

    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
    expect(resolveWaifuChatAccessToken(token, NOW)).toBeNull();
  });

  it("rejects structurally malformed tokens before any claim inspection", () => {
    const [headerSegment, payloadSegment] = signWaifuJwt(claims()).split(".");

    expect(resolveWaifuChatAccessToken("", NOW)).toBeNull();
    expect(resolveWaifuChatAccessToken(null, NOW)).toBeNull();
    expect(resolveWaifuChatAccessToken(undefined, NOW)).toBeNull();
    expect(resolveWaifuChatAccessToken("not-a-jwt", NOW)).toBeNull();
    expect(
      resolveWaifuChatAccessToken(`${headerSegment}.${payloadSegment}`, NOW),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(`${headerSegment}.${payloadSegment}.`, NOW),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(
        `!!!.${payloadSegment}.${signWaifuJwt(claims()).split(".")[2]}`,
        NOW,
      ),
    ).toBeNull();
  });

  it("rejects a correctly-signed token whose header declares a non-HS256 algorithm", () => {
    const headerSegment = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const payloadSegment = Buffer.from(JSON.stringify(claims())).toString(
      "base64url",
    );
    const signature = crypto
      .createHmac("sha256", "waifu-secret")
      .update(`${headerSegment}.${payloadSegment}`)
      .digest("base64url");

    expect(
      resolveWaifuChatAccessToken(
        `${headerSegment}.${payloadSegment}.${signature}`,
        NOW,
      ),
    ).toBeNull();
  });

  it("rejects role claims outside the admin/user/guest vocabulary", () => {
    expect(
      resolveWaifuChatAccessToken(signWaifuJwt(claims({ role: "root" })), NOW),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(signWaifuJwt(claims({ role: "ADMIN" })), NOW),
    ).toBeNull();
    expect(
      resolveWaifuChatAccessToken(signWaifuJwt(claims({ role: "" })), NOW),
    ).toBeNull();
  });

  it("carries balanceTokens through verbatim including an explicit null", () => {
    const explicitNull = resolveWaifuChatAccessToken(
      signWaifuJwt(claims({ balanceTokens: null })),
      NOW,
    );
    expect(explicitNull?.balanceTokens).toBeNull();

    const numeric = resolveWaifuChatAccessToken(
      signWaifuJwt(claims({ balanceTokens: 250_000 })),
      NOW,
    );
    expect(numeric?.balanceTokens).toBe(250_000);

    const absent = resolveWaifuChatAccessToken(signWaifuJwt(claims()), NOW);
    expect(Object.keys(absent ?? {}).includes("balanceTokens")).toBe(false);
  });

  it("binds to ELIZA_CLOUD_AGENT_ID when WAIFU_ELIZA_CLOUD_AGENT_ID is unset", () => {
    process.env.ELIZA_CLOUD_AGENT_ID = "cloud-agent-9";

    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt(claims({ cloudAgentId: "cloud-agent-9" })),
        NOW,
      )?.role,
    ).toBe("guest");
    expect(
      resolveWaifuChatAccessToken(
        signWaifuJwt(claims({ cloudAgentId: "cloud-agent-2" })),
        NOW,
      ),
    ).toBeNull();
    expect(resolveWaifuChatAccessToken(signWaifuJwt(claims()), NOW)).toBeNull();
  });
});

describe("waifu chat route scoping and transport extraction", () => {
  const futureExp = () => Math.floor(Date.now() / 1000) + 60;

  const guestToken = () =>
    signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "guest",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });

  const requestWithHeaders = (headers: Record<string, string>) => {
    const req = new http.IncomingMessage(new Socket());
    req.headers = {};
    for (const [name, value] of Object.entries(headers)) {
      req.headers[name] = value;
    }
    req.headers.host = "agent.example";
    return req;
  };

  beforeEach(() => {
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "waifu-secret";
    process.env.TOKEN_CONTRACT_ADDRESS =
      "0x2222222222222222222222222222222222222222";
    process.env.TOKEN_CHAIN_ID = "56";
    delete process.env.WAIFU_ELIZA_CLOUD_AGENT_ID;
    delete process.env.ELIZA_CLOUD_AGENT_ID;
  });

  afterEach(() => {
    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
    delete process.env.TOKEN_CONTRACT_ADDRESS;
    delete process.env.TOKEN_CHAIN_ID;
    delete process.env.WAIFU_ELIZA_CLOUD_AGENT_ID;
    delete process.env.ELIZA_CLOUD_AGENT_ID;
  });

  it("scopes each chat-safe route by exact method for non-admin principals", () => {
    const cases: Array<[string, string, boolean]> = [
      ["GET", "/api/health", true],
      ["POST", "/api/health", false],
      ["GET", "/api/agents", true],
      ["POST", "/api/agents", false],
      ["GET", "/api/auth/status", true],
      ["GET", "/api/runtime-mode", true],
      ["GET", "/api/conversations", true],
      ["POST", "/api/conversations", true],
      ["DELETE", "/api/conversations", false],
      ["GET", "/api/conversations/conv-1/messages", true],
      ["POST", "/api/conversations/conv-1/messages", true],
      ["PUT", "/api/conversations/conv-1/messages", false],
      ["GET", "/api/conversations/conv-1/messages/stream", false],
      ["POST", "/api/conversations/conv-1/messages/stream", true],
      ["POST", "/api/conversations/conv-1/greeting", true],
      ["GET", "/api/conversations/conv-1/greeting", false],
      ["GET", "/api/agents/ag-1", false],
      ["GET", "/", false],
    ];

    for (const [method, pathname, expected] of cases) {
      expect([
        method,
        pathname,
        isWaifuChatAuthorized(
          requestWithBearer(guestToken()),
          method,
          pathname,
        ),
      ]).toEqual([method, pathname, expected]);
    }
  });

  it("is case-insensitive about the HTTP method when scoping routes", () => {
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(guestToken()),
        "post",
        "/api/conversations/conv-1/messages/stream",
      ),
    ).toBe(true);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(guestToken()),
        "get",
        "/api/health",
      ),
    ).toBe(true);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(guestToken()),
        "delete",
        "/api/conversations/conv-1",
      ),
    ).toBe(false);
  });

  it("lets admins bypass the scoped-route allowlist entirely", () => {
    const adminToken = signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "admin",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });

    expect(
      isWaifuChatAuthorized(requestWithBearer(adminToken), "DELETE", "/"),
    ).toBe(true);
    expect(
      isWaifuChatAuthorized(
        requestWithBearer(adminToken),
        "PATCH",
        "/api/agents/ag-1",
      ),
    ).toBe(true);
  });

  it("returns no access for requests without any recognizable token header", () => {
    expect(
      isWaifuChatAuthorized(requestWithHeaders({}), "GET", "/api/health"),
    ).toBe(false);
  });

  it("resolves waifu tokens presented in fallback auth headers", () => {
    for (const name of [
      "x-eliza-token",
      "x-elizaos-token",
      "x-waifu-chat-access-token",
      "x-api-key",
    ]) {
      expect([
        name,
        isWaifuChatAuthorized(
          requestWithHeaders({ [name]: guestToken() }),
          "GET",
          "/api/health",
        ),
      ]).toEqual([name, true]);
    }

    expect(
      isWaifuChatAuthorized(
        requestWithHeaders({ "x-eliza-token": "not-a-jwt" }),
        "GET",
        "/api/health",
      ),
    ).toBe(false);
  });

  it("prefers the Authorization bearer header over fallback token headers", () => {
    const req = requestWithHeaders({
      authorization: `Bearer ${guestToken()}`,
      "x-eliza-token": "garbage",
    });

    expect(isWaifuChatAuthorized(req, "GET", "/api/health")).toBe(true);
  });
});

describe("waifu resolver registration semantics", () => {
  const futureExp = () => Math.floor(Date.now() / 1000) + 60;

  const adminToken = () =>
    signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: futureExp(),
      role: "admin",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      chainId: 56,
    });

  beforeEach(() => {
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "waifu-secret";
    process.env.TOKEN_CONTRACT_ADDRESS =
      "0x2222222222222222222222222222222222222222";
    process.env.TOKEN_CHAIN_ID = "56";
    clearTokenRoleResolvers();
  });

  afterEach(() => {
    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
    delete process.env.TOKEN_CONTRACT_ADDRESS;
    delete process.env.TOKEN_CHAIN_ID;
    clearTokenRoleResolvers();
  });

  it("re-registering the same id replaces rather than double-stacks, and stale unregister handles are harmless", () => {
    const unregisterFirst = registerTokenRoleResolver(waifuChatRoleResolver);
    const unregisterSecond = registerTokenRoleResolver(waifuChatRoleResolver);

    const access = resolveRegisteredTokenRoleAccess(
      requestWithBearer(adminToken()),
    );
    expect(access?.providerId).toBe("waifu-chat");
    expect(access?.worldRole).toBe("OWNER");

    unregisterSecond();
    expect(
      resolveRegisteredTokenRoleAccess(requestWithBearer(adminToken())),
    ).toBeNull();

    unregisterFirst();
    expect(
      resolveRegisteredTokenRoleAccess(requestWithBearer(adminToken())),
    ).toBeNull();
  });

  it("the resolver defers (null) for requests carrying no waifu token", () => {
    registerTokenRoleResolver(waifuChatRoleResolver);

    const bareRequest = new http.IncomingMessage(new Socket());
    bareRequest.headers = {};

    expect(resolveRegisteredTokenRoleAccess(bareRequest)).toBeNull();
    expect(
      isRegisteredTokenRoleAuthorized(bareRequest, "GET", "/api/health"),
    ).toBe(false);
  });
});
