import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import bs58 from "bs58";
import { StewardAuth } from "../auth.ts";

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

async function startStewardServer(
  handler: (request: CapturedRequest) => Promise<ResponsePayload> | ResponsePayload,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const bodyText = await readRequestBody(req);
    const bodyJson = bodyText.length > 0 ? (JSON.parse(bodyText) as unknown) : undefined;
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
): StewardAuth {
  const auth = new StewardAuth({
    baseUrl,
    storage,
    tenantId,
  });

  storage.setItem("steward_session_token", fakeJwt());
  storage.setItem("steward_refresh_token", "refresh-token-123");
  return auth;
}

describe("StewardAuth multi-tenant", () => {
  let storage: TestStorage;

  beforeEach(() => {
    storage = new TestStorage();
  });

  afterEach(() => {
    storage.clear();
  });

  describe("tenantId in config", () => {
    test("getTenantId returns configured value", () => {
      const auth = new StewardAuth({
        baseUrl: "http://127.0.0.1:1",
        storage,
        tenantId: "my-app",
      });
      expect(auth.getTenantId()).toBe("my-app");
    });

    test("getTenantId returns undefined when not configured", () => {
      const auth = new StewardAuth({
        baseUrl: "http://127.0.0.1:1",
        storage,
      });
      expect(auth.getTenantId()).toBeUndefined();
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
      const server = await startStewardServer((request) => {
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
      const auth = new StewardAuth({
        baseUrl: "http://127.0.0.1:1",
        storage,
      });

      await expect(auth.listTenants()).rejects.toThrow("Not authenticated");
    });
  });

  describe("joinTenant", () => {
    test("posts to join endpoint", async () => {
      const server = await startStewardServer((request) => {
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

  describe("leaveTenant", () => {
    test("sends DELETE to leave endpoint", async () => {
      const server = await startStewardServer((request) => {
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
      const server = await startStewardServer((request) => {
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
        expect(storage.getItem("steward_refresh_token")).toBe("refresh-token-123");
      } finally {
        await server.close();
      }
    });
  });

  describe("signInWithSIWE", () => {
    test("prefers backend userId over tenant.id", async () => {
      const token = fakeJwt({ address: "0xabc", userId: "user-siwe" });
      const server = await startStewardServer((request) => {
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
        const auth = new StewardAuth({ baseUrl: server.baseUrl, storage });
        const result = await auth.signInWithSIWE("0xabc", async () => "0xsigned");

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
      const token = fakeJwt({ address: "So11111111111111111111111111111111111111112" });
      const server = await startStewardServer((request) => {
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
        expect(body.publicKey).toBe("So11111111111111111111111111111111111111112");
        expect(body.message).toContain("wants you to sign in with your Solana account:");
        expect(body.message).toContain("Nonce: nonce-123");
        expect(body.message).toContain("Chain ID: mainnet");
        expect(bs58.decode(body.signature)).toEqual(new Uint8Array([1, 2, 3, 4]));
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
            tenant: { id: "solana:So11111111111111111111111111111111111111112", name: "sol" },
          },
        };
      });

      try {
        const auth = new StewardAuth({ baseUrl: server.baseUrl, storage });
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
      const server = await startStewardServer((request) => {
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
        expect(storage.getItem("steward_refresh_token")).toBe("new-refresh-token");
      } finally {
        await server.close();
      }
    });

    test("returns null when no refresh token", async () => {
      const auth = new StewardAuth({
        baseUrl: "http://127.0.0.1:1",
        storage,
      });
      storage.setItem("steward_session_token", fakeJwt());

      const result = await auth.switchTenant("new-app");
      expect(result).toBeNull();
    });

    test("returns null when refresh fails", async () => {
      const server = await startStewardServer((request) => {
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
