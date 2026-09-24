import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import bs58 from "bs58";
import { LoginAuth } from "../auth.ts";

class TestStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

type CapturedRequest = {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  bodyText: string;
  bodyJson: unknown;
};

type ResponsePayload = {
  status?: number;
  json?: unknown;
};

function fakeJwt(payload: Record<string, unknown> = {}): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      address: "0x1234",
      tenantId: "test-tenant",
      userId: "user-1",
      email: "test@example.com",
      ...payload,
    }),
  );
  return `${header}.${body}.fake-sig`;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startLoginServer(
  handler: (
    request: CapturedRequest,
  ) => Promise<ResponsePayload> | ResponsePayload,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const bodyText = await readRequestBody(req);
    const bodyJson =
      bodyText.length > 0 ? (JSON.parse(bodyText) as unknown) : undefined;
    const response = await handler({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: req.headers,
      bodyText,
      bodyJson,
    });

    res.writeHead(response.status ?? 200, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(response.json ?? { ok: true }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function createAuthWithSession(
  storage: TestStorage,
  baseUrl: string,
  tenantId?: string,
): LoginAuth {
  const auth = new LoginAuth({
    baseUrl,
    storage,
    tenantId,
  });

  storage.setItem("steward_session_token", fakeJwt());
  storage.setItem("steward_refresh_token", "refresh-token-123");
  return auth;
}

describe("LoginAuth multi-tenant", () => {
  let storage: TestStorage;

  beforeEach(() => {
    storage = new TestStorage();
  });

  afterEach(() => {
    storage.clear();
  });

  describe("tenantId in config", () => {
    test("getTenantId returns configured value", () => {
      const auth = new LoginAuth({
        baseUrl: "http://127.0.0.1:1",
        storage,
        tenantId: "my-app",
      });
      expect(auth.getTenantId()).toBe("my-app");
    });

    test("getTenantId returns undefined when not configured", () => {
      const auth = new LoginAuth({
        baseUrl: "http://127.0.0.1:1",
        storage,
      });
      expect(auth.getTenantId()).toBeUndefined();
    });

    test("getSession exposes MFA freshness claims from stored tokens", () => {
      const auth = new LoginAuth({
        baseUrl: "http://127.0.0.1:1",
        storage,
      });
      storage.setItem(
        "steward_session_token",
        fakeJwt({
          mfaVerifiedAt: 1_770_000_000_000,
          mfaMethod: "passkey",
          factorEnrollmentVerifiedAt: 1_770_000_000_111,
        }),
      );

      const session = auth.getSession();
      expect(session?.mfaVerifiedAt).toBe(1_770_000_000_000);
      expect(session?.mfaMethod).toBe("passkey");
      expect(session?.factorEnrollmentVerifiedAt).toBe(1_770_000_000_111);
    });
  });

  describe("listTenants", () => {
    test("fetches user tenants with auth header", async () => {
      const tenants = [
        {
          tenantId: "app-1",
          tenantName: "Babylon",
          role: "member",
          joinedAt: "2026-01-01",
        },
        {
          tenantId: "personal-user-1",
          tenantName: "Personal",
          role: "owner",
          joinedAt: "2026-01-01",
        },
      ];
      const server = await startLoginServer((request) => {
        expect(request.method).toBe("GET");
        expect(request.path).toBe("/user/me/tenants");
        expect(request.headers.authorization).toBe(
          `Bearer ${storage.getItem("steward_session_token")}`,
        );
        return { json: { ok: true, data: tenants } };
      });

      try {
        const auth = createAuthWithSession(storage, server.baseUrl);
        const result = await auth.listTenants();
        expect(result).toHaveLength(2);
        expect(result[0]?.tenantName).toBe("Babylon");
      } finally {
        await server.close();
      }
    });

    test("throws when not authenticated", async () => {
      const auth = new LoginAuth({
        baseUrl: "http://127.0.0.1:1",
        storage,
      });

      await expect(auth.listTenants()).rejects.toThrow("Not authenticated");
    });
  });

  describe("getCurrentUser", () => {
    test("passes configured tenant to /user/me bootstrap", async () => {
      const server = await startLoginServer((request) => {
        expect(request.method).toBe("GET");
        expect(request.path).toBe("/user/me?tenantId=my-app");
        expect(request.headers["x-steward-tenant"]).toBe("my-app");
        expect(request.headers.authorization).toBe(
          `Bearer ${storage.getItem("steward_session_token")}`,
        );
        return {
          json: {
            ok: true,
            data: {
              userId: "user-1",
              email: "test@example.com",
              wallet: {
                agentId: "user-wallet-user-1",
                address: "0x1234567890123456789012345678901234567890",
              },
              walletAutoCreated: true,
              embeddedWalletConfig: {
                tenantId: "my-app",
                createOnLogin: "users-without-wallets",
              },
            },
          },
        };
      });

      try {
        const auth = createAuthWithSession(storage, server.baseUrl, "my-app");
        const result = await auth.getCurrentUser();
        expect(result.walletAutoCreated).toBe(true);
        expect(result.embeddedWalletConfig).toEqual({
          tenantId: "my-app",
          createOnLogin: "users-without-wallets",
        });
      } finally {
        await server.close();
      }
    });
  });

  describe("current-session MFA step-up", () => {
    test("stepUpWithTotp posts a bearer-authenticated TOTP code and stores refreshed tokens", async () => {
      const steppedUpToken = fakeJwt({
        mfaVerifiedAt: 1_770_000_000_000,
        mfaMethod: "totp",
      });
      const server = await startLoginServer((request) => {
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/auth/mfa/totp/step-up");
        expect(request.headers.authorization).toBe(
          `Bearer ${storage.getItem("steward_session_token")}`,
        );
        expect(request.bodyJson).toEqual({ code: "123456" });
        return {
          json: {
            ok: true,
            token: steppedUpToken,
            refreshToken: "totp-step-up-refresh",
            expiresIn: 900,
            user: { id: "user-1", email: "test@example.com" },
          },
        };
      });

      try {
        const auth = createAuthWithSession(storage, server.baseUrl);
        const result = await auth.stepUpWithTotp("123456");
        expect(result.token).toBe(steppedUpToken);
        expect(storage.getItem("steward_session_token")).toBe(steppedUpToken);
        expect(storage.getItem("steward_refresh_token")).toBe(
          "totp-step-up-refresh",
        );
        expect(auth.getSession()?.mfaMethod).toBe("totp");
      } finally {
        await server.close();
      }
    });

    test("stepUpWithRecoveryCode and stepUpWithSms use current-session step-up endpoints", async () => {
      const calls: string[] = [];
      const server = await startLoginServer((request) => {
        calls.push(request.path);
        expect(request.headers.authorization).toBe(
          `Bearer ${storage.getItem("steward_session_token")}`,
        );
        if (request.path === "/auth/mfa/totp/step-up") {
          expect(request.bodyJson).toEqual({ recoveryCode: "ABCDE-FGHJK" });
          return {
            json: {
              ok: true,
              token: fakeJwt({ mfaMethod: "recovery_code" }),
              refreshToken: "recovery-step-up-refresh",
              expiresIn: 900,
              user: { id: "user-1", email: "test@example.com" },
            },
          };
        }
        expect(request.path).toBe("/auth/mfa/sms/step-up");
        expect(request.bodyJson).toEqual({ code: "654321" });
        return {
          json: {
            ok: true,
            token: fakeJwt({ mfaMethod: "sms" }),
            refreshToken: "sms-step-up-refresh",
            expiresIn: 900,
            user: { id: "user-1", email: "test@example.com" },
          },
        };
      });

      try {
        const auth = createAuthWithSession(storage, server.baseUrl);
        await auth.stepUpWithRecoveryCode("ABCDE-FGHJK");
        expect(auth.getSession()?.mfaMethod).toBe("recovery_code");
        await auth.stepUpWithSms("654321");
        expect(auth.getSession()?.mfaMethod).toBe("sms");
        expect(calls).toEqual([
          "/auth/mfa/totp/step-up",
          "/auth/mfa/sms/step-up",
        ]);
      } finally {
        await server.close();
      }
    });
  });

  describe("guest lifecycle", () => {
    test("signInAsGuest stores tokens and reports 30-day expiry messaging", async () => {
      const guestExpiresAt = new Date(
        Date.now() + 3 * 86_400_000,
      ).toISOString();
      const token = fakeJwt({
        userId: "guest-1",
        email: undefined,
        guest: true,
        guestExpiresAt,
      });
      const server = await startLoginServer((request) => {
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/auth/guest");
        expect(request.bodyJson).toEqual({
          tenantId: "my-app",
          expiresIn: "7d",
        });
        return {
          json: {
            ok: true,
            token,
            refreshToken: "guest-refresh",
            expiresIn: 900,
            user: {
              id: "guest-1",
              email: null,
              isGuest: true,
              guestExpiresAt,
              tenantId: "my-app",
            },
          },
        };
      });

      try {
        const auth = new LoginAuth({
          baseUrl: server.baseUrl,
          storage,
          tenantId: "my-app",
        });
        const result = await auth.signInAsGuest({ expiresIn: "7d" });
        expect(result.user.isGuest).toBe(true);
        expect(storage.getItem("steward_session_token")).toBe(token);
        expect(storage.getItem("steward_refresh_token")).toBe("guest-refresh");
        expect(auth.getGuestState()).toMatchObject({
          isGuest: true,
          userId: "guest-1",
          tenantId: "test-tenant",
          expiresAt: guestExpiresAt,
          isExpired: false,
        });
        expect(auth.getGuestState().expiryMessage).toContain("expires in");
      } finally {
        await server.close();
      }
    });

    test("upgradeGuestWithEmail requires a guest session and exchanges verified email token", async () => {
      const guestToken = fakeJwt({
        userId: "guest-2",
        guest: true,
        guestExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const upgradedToken = fakeJwt({
        userId: "guest-2",
        email: "guest@example.test",
        guest: false,
        guestExpiresAt: undefined,
      });
      storage.setItem("steward_session_token", guestToken);
      storage.setItem("steward_refresh_token", "guest-refresh");
      const server = await startLoginServer((request) => {
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/auth/guest/upgrade");
        expect(request.headers.authorization).toBe(`Bearer ${guestToken}`);
        expect(request.bodyJson).toEqual({
          method: "email",
          email: "guest@example.test",
          token: "magic-token",
        });
        return {
          json: {
            ok: true,
            token: upgradedToken,
            refreshToken: "upgraded-refresh",
            expiresIn: 900,
            user: {
              id: "guest-2",
              email: "guest@example.test",
              isGuest: false,
            },
          },
        };
      });

      try {
        const auth = new LoginAuth({ baseUrl: server.baseUrl, storage });
        const result = await auth.upgradeGuestWithEmail({
          email: "guest@example.test",
          token: "magic-token",
        });
        expect("mfaRequired" in result).toBe(false);
        expect(storage.getItem("steward_session_token")).toBe(upgradedToken);
        expect(storage.getItem("steward_refresh_token")).toBe(
          "upgraded-refresh",
        );
        expect(auth.getGuestState().isGuest).toBe(false);
      } finally {
        await server.close();
      }

      const fullAuth = createAuthWithSession(storage, "http://127.0.0.1:1");
      await expect(
        fullAuth.upgradeGuestWithEmail({
          email: "full@example.test",
          token: "token",
        }),
      ).rejects.toThrow("not a guest");
    });

    test("deleteGuest calls the explicit delete endpoint and clears local storage", async () => {
      const guestToken = fakeJwt({
        userId: "guest-3",
        guest: true,
        guestExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      storage.setItem("steward_session_token", guestToken);
      storage.setItem("steward_refresh_token", "guest-refresh");
      const server = await startLoginServer((request) => {
        expect(request.method).toBe("DELETE");
        expect(request.path).toBe("/auth/guest");
        expect(request.headers.authorization).toBe(`Bearer ${guestToken}`);
        return { json: { ok: true, deleted: true, userId: "guest-3" } };
      });

      try {
        const auth = new LoginAuth({ baseUrl: server.baseUrl, storage });
        const result = await auth.deleteGuest();
        expect(result).toEqual({ ok: true, deleted: true, userId: "guest-3" });
        expect(storage.getItem("steward_session_token")).toBeNull();
        expect(storage.getItem("steward_refresh_token")).toBeNull();
      } finally {
        await server.close();
      }
    });
  });

  describe("joinTenant", () => {
    test("posts to join endpoint", async () => {
      const server = await startLoginServer((request) => {
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/user/me/tenants/babylon/join");
        return {
          json: {
            ok: true,
            tenantId: "babylon",
            tenantName: "Babylon",
            role: "member",
            joinedAt: "2026-04-10",
          },
        };
      });

      try {
        const auth = createAuthWithSession(storage, server.baseUrl);
        const result = await auth.joinTenant("babylon");
        expect(result.tenantId).toBe("babylon");
        expect(result.role).toBe("member");
      } finally {
        await server.close();
      }
    });
  });

  describe("acceptTenantInvitation", () => {
    test("posts invite token to acceptance endpoint", async () => {
      const server = await startLoginServer((request) => {
        expect(request.method).toBe("POST");
        expect(request.path).toBe(
          "/user/me/tenants/babylon/invitations/accept",
        );
        expect(request.bodyJson).toEqual({ token: "invite-token" });
        return {
          json: {
            ok: true,
            tenantId: "babylon",
            role: "developer",
            invitationId: "invite-1",
          },
        };
      });

      try {
        const auth = createAuthWithSession(storage, server.baseUrl);
        const result = await auth.acceptTenantInvitation(
          "babylon",
          "invite-token",
        );
        expect(result.tenantId).toBe("babylon");
        expect(result.role).toBe("developer");
        expect(result.invitationId).toBe("invite-1");
      } finally {
        await server.close();
      }
    });
  });

  describe("leaveTenant", () => {
    test("sends DELETE to leave endpoint", async () => {
      const server = await startLoginServer((request) => {
        expect(request.method).toBe("DELETE");
        expect(request.path).toBe("/user/me/tenants/some-app/leave");
        return { json: { ok: true } };
      });

      try {
        const auth = createAuthWithSession(storage, server.baseUrl);
        await expect(auth.leaveTenant("some-app")).resolves.toBeUndefined();
      } finally {
        await server.close();
      }
    });
  });

  describe("refreshSession", () => {
    test("keeps local session on 5xx refresh failures", async () => {
      const server = await startLoginServer((request) => {
        expect(request.path).toBe("/auth/refresh");
        return {
          status: 503,
          json: { ok: false, error: "temporary failure" },
        };
      });

      try {
        const auth = createAuthWithSession(storage, server.baseUrl);
        const result = await auth.refreshSession();
        expect(result).toBeNull();
        expect(storage.getItem("steward_session_token")).not.toBeNull();
        expect(storage.getItem("steward_refresh_token")).toBe(
          "refresh-token-123",
        );
      } finally {
        await server.close();
      }
    });
  });

  describe("signInWithSIWE", () => {
    test("prefers backend userId over tenant.id", async () => {
      const token = fakeJwt({ address: "0xabc", userId: "user-siwe" });
      const server = await startLoginServer((request) => {
        if (request.path === "/auth/nonce") {
          return { json: { nonce: "nonce-456" } };
        }

        expect(request.method).toBe("POST");
        expect(request.path).toBe("/auth/verify");
        return {
          json: {
            ok: true,
            token,
            refreshToken: "siwe-refresh",
            expiresIn: 900,
            userId: "user-siwe",
            address: "0xabc",
            walletChain: "ethereum",
            tenant: { id: "tenant-should-not-win", name: "tenant" },
          },
        };
      });

      try {
        const auth = new LoginAuth({ baseUrl: server.baseUrl, storage });
        const result = await auth.signInWithSIWE(
          "0xabc",
          async () => "0xsigned",
        );

        expect(result.user).toEqual({
          id: "user-siwe",
          email: "",
          walletAddress: "0xabc",
          walletChain: "ethereum",
        });
      } finally {
        await server.close();
      }
    });
  });

  describe("signInWithSolana", () => {
    test("builds SIWS message, signs bytes, and stores session", async () => {
      const signedMessages: string[] = [];
      const token = fakeJwt({
        address: "So11111111111111111111111111111111111111112",
      });
      const server = await startLoginServer((request) => {
        if (request.path === "/auth/nonce") {
          expect(request.method).toBe("GET");
          return { json: { nonce: "nonce-123" } };
        }

        expect(request.method).toBe("POST");
        expect(request.path).toBe("/auth/verify/solana");
        const body = request.bodyJson as {
          message: string;
          signature: string;
          publicKey: string;
        };
        expect(body.publicKey).toBe(
          "So11111111111111111111111111111111111111112",
        );
        expect(body.message).toContain(
          "wants you to sign in with your Solana account:",
        );
        expect(body.message).toContain("Nonce: nonce-123");
        expect(body.message).toContain("Chain ID: mainnet");
        expect(bs58.decode(body.signature)).toEqual(
          new Uint8Array([1, 2, 3, 4]),
        );
        return {
          json: {
            ok: true,
            token,
            refreshToken: "sol-refresh",
            expiresIn: 900,
            userId: "user-solana",
            address: "tenant-shaped-address-that-should-not-win",
            publicKey: body.publicKey,
            walletChain: "solana",
            tenant: {
              id: "solana:So11111111111111111111111111111111111111112",
              name: "sol",
            },
          },
        };
      });

      try {
        const auth = new LoginAuth({ baseUrl: server.baseUrl, storage });
        const result = await auth.signInWithSolana(
          "So11111111111111111111111111111111111111112",
          async (messageBytes) => {
            signedMessages.push(new TextDecoder().decode(messageBytes));
            return new Uint8Array([1, 2, 3, 4]);
          },
        );

        expect(signedMessages).toHaveLength(1);
        expect(result.user).toEqual({
          id: "user-solana",
          email: "",
          walletAddress: "So11111111111111111111111111111111111111112",
          walletChain: "solana",
        });
        expect(storage.getItem("steward_session_token")).toBe(token);
        expect(storage.getItem("steward_refresh_token")).toBe("sol-refresh");
      } finally {
        await server.close();
      }
    });
  });

  describe("switchTenant", () => {
    test("refreshes session with new tenantId", async () => {
      const newToken = fakeJwt({ tenantId: "new-app" });
      const server = await startLoginServer((request) => {
        expect(request.method).toBe("POST");
        expect(request.path).toBe("/auth/refresh");
        expect(request.bodyJson).toEqual({
          refreshToken: "refresh-token-123",
          tenantId: "new-app",
        });
        return {
          json: {
            ok: true,
            token: newToken,
            refreshToken: "new-refresh-token",
            expiresIn: 900,
          },
        };
      });

      try {
        const auth = createAuthWithSession(storage, server.baseUrl);
        const session = await auth.switchTenant("new-app");
        expect(session).not.toBeNull();
        expect(session?.tenantId).toBe("new-app");
        expect(storage.getItem("steward_session_token")).toBe(newToken);
        expect(storage.getItem("steward_refresh_token")).toBe(
          "new-refresh-token",
        );
      } finally {
        await server.close();
      }
    });

    test("returns null when no refresh token", async () => {
      const auth = new LoginAuth({
        baseUrl: "http://127.0.0.1:1",
        storage,
      });
      storage.setItem("steward_session_token", fakeJwt());

      const result = await auth.switchTenant("new-app");
      expect(result).toBeNull();
    });

    test("returns null when refresh fails", async () => {
      const server = await startLoginServer((request) => {
        expect(request.path).toBe("/auth/refresh");
        return {
          status: 401,
          json: { ok: false, error: "Invalid refresh token" },
        };
      });

      try {
        const auth = createAuthWithSession(storage, server.baseUrl);
        const result = await auth.switchTenant("new-app");
        expect(result).toBeNull();
      } finally {
        await server.close();
      }
    });
  });
});
