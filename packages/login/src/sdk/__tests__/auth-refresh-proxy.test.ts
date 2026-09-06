/** Exercises SDK session custody and revocation over deterministic HTTP endpoints. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { requireLoginValue } from "../../required";
import { LoginAuth } from "../auth.ts";

/**
 * SEC-018 regression tests: when `authProxyUrl` is configured, the long-lived
 * refresh token must never touch JS-readable storage. Sign-in deposits it with
 * the same-origin proxy (HttpOnly cookie), and refresh/revoke/tenant-switch
 * calls go to the proxy without a token in the request body.
 */

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
  bodyJson: Record<string, unknown> | undefined;
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

type ResponsePayload = { status?: number; json?: unknown };

async function startServer(
  handler: (
    request: CapturedRequest,
  ) => Promise<ResponsePayload> | ResponsePayload,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const bodyText = await readRequestBody(req);
    const response = await handler({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: req.headers,
      bodyJson:
        bodyText.length > 0
          ? (JSON.parse(bodyText) as Record<string, unknown>)
          : undefined,
    });
    res.writeHead(response.status ?? 200, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(response.json ?? { ok: true }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) =>
      error ? reject(error) : resolve(),
    );
  });

  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const TEST_USER = {
  id: "user-1",
  email: "test@example.com",
  walletAddress: "0x1234",
  walletChain: "evm",
};

describe("LoginAuth authProxyUrl (SEC-018: HttpOnly refresh-token custody)", () => {
  let storage: TestStorage;
  let requests: CapturedRequest[];
  let server: { baseUrl: string; close: () => Promise<void> } | null = null;
  let proxyDepositFails: boolean;
  let originalWindow: typeof globalThis.window | undefined;
  let originalNavigator: typeof globalThis.navigator | undefined;
  let logoutEpoch: string | null;
  let storageListeners: Array<(event: Pick<StorageEvent, "key">) => void>;
  let lockTail: Promise<void>;

  beforeEach(async () => {
    originalWindow = globalThis.window;
    originalNavigator = globalThis.navigator;
    logoutEpoch = null;
    storageListeners = [];
    lockTail = Promise.resolve();
    const sharedLocalStorage = {
      getItem: (key: string) =>
        key === "steward_auth_logout_epoch" ? logoutEpoch : null,
      setItem: (key: string, value: string) => {
        if (key !== "steward_auth_logout_epoch") return;
        logoutEpoch = value;
        for (const listener of storageListeners) listener({ key });
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        document: {},
        localStorage: sharedLocalStorage,
        addEventListener: (
          type: string,
          listener: (event: StorageEvent) => void,
        ) => {
          if (type === "storage") storageListeners.push(listener);
        },
        location: {
          get origin() {
            return server?.baseUrl ?? "https://app.example.test";
          },
          get host() {
            return new URL(server?.baseUrl ?? "https://app.example.test").host;
          },
        },
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, callback: () => Promise<unknown>) => {
            const predecessor = lockTail;
            let release!: () => void;
            lockTail = new Promise<void>((resolve) => {
              release = resolve;
            });
            await predecessor;
            try {
              return await callback();
            } finally {
              release();
            }
          },
        },
      },
    });
    storage = new TestStorage();
    requests = [];
    proxyDepositFails = false;
    server = await startServer((req) => {
      requests.push(req);
      if (req.path === "/auth/email/verify") {
        return {
          json: {
            ok: true,
            token: fakeJwt(),
            refreshToken: "rt-secret-1",
            user: TEST_USER,
          },
        };
      }
      if (req.path === "/proxy/session" && req.method === "POST") {
        if (proxyDepositFails) {
          return { status: 500, json: { ok: false, error: "proxy down" } };
        }
        return { json: { ok: true } };
      }
      if (req.path === "/proxy/session" && req.method === "DELETE") {
        return { json: { ok: true } };
      }
      if (req.path === "/proxy/refresh") {
        return {
          json: {
            ok: true,
            token: fakeJwt({ userId: "user-2" }),
            expiresIn: 900,
          },
        };
      }
      if (req.path === "/proxy/revoke" || req.path === "/auth/logout") {
        return { json: { ok: true } };
      }
      return { status: 404, json: { ok: false, error: "not found" } };
    });
  });

  afterEach(async () => {
    storage.clear();
    await server?.close();
    server = null;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  });

  function proxyRequests(path: string, method?: string): CapturedRequest[] {
    return requests.filter(
      (r) => r.path === path && (!method || r.method === method),
    );
  }

  test("rejects cross-origin, credential-bearing, and ambiguous proxy URLs", () => {
    for (const authProxyUrl of [
      "https://evil.example/proxy",
      "//evil.example/proxy",
      `${requireLoginValue(server, "server").baseUrl.replace("http://", "http://user:password@")}/proxy`,
      `${requireLoginValue(server, "server").baseUrl}/proxy?next=https://evil.example`,
      `${requireLoginValue(server, "server").baseUrl}/proxy#fragment`,
    ]) {
      expect(
        () =>
          new LoginAuth({
            baseUrl: requireLoginValue(server, "server").baseUrl,
            storage,
            authProxyUrl,
          }),
      ).toThrow(/authProxyUrl/);
    }
  });

  test("sign-in deposits the refresh token with the proxy, never with JS storage", async () => {
    const auth = new LoginAuth({
      baseUrl: requireLoginValue(server, "server").baseUrl,
      storage,
      authProxyUrl: `${requireLoginValue(server, "server").baseUrl}/proxy`,
    });

    await auth.verifyEmailCallback("magic-token", "test@example.com");

    const deposits = proxyRequests("/proxy/session", "POST");
    expect(deposits).toHaveLength(1);
    expect(deposits[0].bodyJson).toEqual({ refreshToken: "rt-secret-1" });
    expect(deposits[0].headers["x-steward-auth-proxy"]).toBe("1");

    expect(storage.getItem("steward_session_token")).toMatch(
      /^[^.]+\.[^.]+\.[^.]+$/,
    );
    expect(storage.getItem("steward_refresh_token")).toBeNull();
  });

  test("sign-in fails closed when the refresh-token deposit fails", async () => {
    proxyDepositFails = true;
    const auth = new LoginAuth({
      baseUrl: requireLoginValue(server, "server").baseUrl,
      storage,
      authProxyUrl: `${requireLoginValue(server, "server").baseUrl}/proxy`,
    });

    await expect(
      auth.verifyEmailCallback("magic-token", "test@example.com"),
    ).rejects.toThrow(/secure the refresh token/i);
    // The refresh token must not fall back to JS-readable storage.
    expect(storage.getItem("steward_refresh_token")).toBeNull();
    // A failed custody handoff must not leave a partially authenticated access
    // token behind either.
    expect(storage.getItem("steward_session_token")).toBeNull();
  });

  test("a sign-out racing the refresh-token deposit cannot resurrect the session", async () => {
    await server?.close();
    server = await startServer(async (req) => {
      requests.push(req);
      if (req.path === "/auth/email/verify") {
        return {
          json: {
            ok: true,
            token: fakeJwt(),
            refreshToken: "rt-stale",
            user: TEST_USER,
          },
        };
      }
      if (req.path === "/proxy/session" && req.method === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { json: { ok: true } };
      }
      if (req.path === "/proxy/session" && req.method === "DELETE") {
        return { json: { ok: true } };
      }
      return { status: 404, json: { ok: false, error: "not found" } };
    });
    const auth = new LoginAuth({
      baseUrl: server.baseUrl,
      storage,
      authProxyUrl: `${server.baseUrl}/proxy`,
    });

    const signIn = auth.verifyEmailCallback("magic-token", "test@example.com");
    while (proxyRequests("/proxy/session", "POST").length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    auth.signOut();

    await expect(signIn).rejects.toThrow(/cancelled by sign-out/i);
    await lockTail;
    expect(storage.getItem("steward_session_token")).toBeNull();
    expect(storage.getItem("steward_refresh_token")).toBeNull();
    expect(
      proxyRequests("/proxy/session", "DELETE").length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("refreshSession calls the proxy without a JS-held token", async () => {
    const auth = new LoginAuth({
      baseUrl: requireLoginValue(server, "server").baseUrl,
      storage,
      authProxyUrl: `${requireLoginValue(server, "server").baseUrl}/proxy`,
    });
    storage.setItem("steward_session_token", fakeJwt());

    const session = await auth.refreshSession();

    expect(session?.userId).toBe("user-2");
    const refreshes = proxyRequests("/proxy/refresh", "POST");
    expect(refreshes).toHaveLength(1);
    // No refresh token is ever sent from JS — the proxy injects the cookie.
    expect(refreshes[0].bodyJson).toEqual({});
    expect(refreshes[0].headers["x-steward-auth-proxy"]).toBe("1");
    // The API's direct /auth/refresh endpoint is never called.
    expect(proxyRequests("/auth/refresh")).toHaveLength(0);
  });

  test("coalesces concurrent refreshes so a one-time token is never replayed", async () => {
    await server?.close();
    server = await startServer(async (req) => {
      requests.push(req);
      if (req.path === "/proxy/refresh") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          json: {
            ok: true,
            token: fakeJwt({ userId: "user-2" }),
            expiresIn: 900,
          },
        };
      }
      return { json: { ok: true } };
    });
    const auth = new LoginAuth({
      baseUrl: server.baseUrl,
      storage,
      authProxyUrl: `${server.baseUrl}/proxy`,
    });
    storage.setItem("steward_session_token", fakeJwt());

    const sessions = await Promise.all([
      auth.refreshSession(),
      auth.refreshSession(),
      auth.refreshSession(),
    ]);

    expect(sessions.every((session) => session?.userId === "user-2")).toBe(
      true,
    );
    expect(proxyRequests("/proxy/refresh", "POST")).toHaveLength(1);
  });

  test("serializes proxy refreshes across client instances with the origin lock", async () => {
    await server?.close();
    let activeRefreshes = 0;
    let maximumActiveRefreshes = 0;
    server = await startServer(async (req) => {
      requests.push(req);
      if (req.path === "/proxy/refresh") {
        activeRefreshes += 1;
        maximumActiveRefreshes = Math.max(
          maximumActiveRefreshes,
          activeRefreshes,
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeRefreshes -= 1;
        return { json: { ok: true, token: fakeJwt(), expiresIn: 900 } };
      }
      return { json: { ok: true } };
    });
    const authA = new LoginAuth({
      baseUrl: server.baseUrl,
      storage: new TestStorage(),
      authProxyUrl: `${server.baseUrl}/proxy`,
    });
    const authB = new LoginAuth({
      baseUrl: server.baseUrl,
      storage: new TestStorage(),
      authProxyUrl: `${server.baseUrl}/proxy`,
    });

    const sessions = await Promise.all([
      authA.refreshSession(),
      authB.refreshSession(),
    ]);

    expect(sessions.every((session) => session?.userId === "user-1")).toBe(
      true,
    );
    expect(proxyRequests("/proxy/refresh", "POST")).toHaveLength(2);
    expect(maximumActiveRefreshes).toBe(1);
  });

  test("serializes refresh and tenant switching across the same rotating token", async () => {
    await server?.close();
    let expectedRefreshToken = "rt-secret-1";
    let rotation = 1;
    server = await startServer(async (req) => {
      requests.push(req);
      if (req.path === "/auth/email/verify") {
        return {
          json: {
            ok: true,
            token: fakeJwt(),
            refreshToken: expectedRefreshToken,
            user: TEST_USER,
          },
        };
      }
      if (req.path === "/auth/refresh") {
        if (req.bodyJson?.refreshToken !== expectedRefreshToken) {
          return {
            status: 401,
            json: { ok: false, error: "refresh token replayed" },
          };
        }
        rotation += 1;
        expectedRefreshToken = `rt-secret-${rotation}`;
        // Leave a window in which an unserialized tenant switch would replay
        // the predecessor token and revoke the family.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          json: {
            ok: true,
            token: fakeJwt({
              tenantId: req.bodyJson?.tenantId ?? "test-tenant",
            }),
            refreshToken: expectedRefreshToken,
            expiresIn: 900,
          },
        };
      }
      return { status: 404, json: { ok: false, error: "not found" } };
    });
    const auth = new LoginAuth({ baseUrl: server.baseUrl, storage });
    await auth.verifyEmailCallback("magic-token", "test@example.com");
    requests = [];

    const [refreshed, switched] = await Promise.all([
      auth.refreshSession(),
      auth.switchTenant("tenant-2"),
    ]);

    expect(refreshed).not.toBeNull();
    expect(switched?.tenantId).toBe("tenant-2");
    const rotations = proxyRequests("/auth/refresh", "POST");
    expect(rotations.map((request) => request.bodyJson?.refreshToken)).toEqual([
      "rt-secret-1",
      "rt-secret-2",
    ]);
    expect(storage.getItem("steward_refresh_token")).toBe("rt-secret-3");
  });

  test("an in-flight proxy refresh cannot resurrect a signed-out session", async () => {
    await server?.close();
    server = await startServer(async (req) => {
      requests.push(req);
      if (req.path === "/proxy/refresh") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          json: {
            ok: true,
            token: fakeJwt({ userId: "stale-user" }),
            expiresIn: 900,
          },
        };
      }
      return { json: { ok: true } };
    });
    const auth = new LoginAuth({
      baseUrl: server.baseUrl,
      storage,
      authProxyUrl: `${server.baseUrl}/proxy`,
    });
    storage.setItem("steward_session_token", fakeJwt());

    const refresh = auth.refreshSession();
    while (proxyRequests("/proxy/refresh", "POST").length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    auth.signOut();

    expect(await refresh).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storage.getItem("steward_session_token")).toBeNull();
    expect(
      proxyRequests("/proxy/session", "DELETE").length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("cross-tab sign-out wins an in-flight refresh under the shared origin lock", async () => {
    await server?.close();
    let cookieLive = true;
    const orderedMutations: string[] = [];
    server = await startServer(async (req) => {
      requests.push(req);
      if (req.path === "/proxy/refresh") {
        orderedMutations.push("refresh:start");
        await new Promise((resolve) => setTimeout(resolve, 30));
        cookieLive = true;
        orderedMutations.push("refresh:rotated");
        return {
          json: {
            ok: true,
            token: fakeJwt({ userId: "stale-user" }),
            expiresIn: 900,
          },
        };
      }
      if (req.path === "/proxy/session" && req.method === "DELETE") {
        orderedMutations.push("cookie:delete");
        cookieLive = false;
        return { json: { ok: true } };
      }
      if (req.path === "/proxy/revoke") {
        orderedMutations.push("revoke");
        cookieLive = false;
        return { json: { ok: true } };
      }
      return { json: { ok: true } };
    });
    const storageA = new TestStorage();
    const storageB = new TestStorage();
    storageA.setItem("steward_session_token", fakeJwt());
    storageB.setItem("steward_session_token", fakeJwt());
    const authA = new LoginAuth({
      baseUrl: server.baseUrl,
      storage: storageA,
      authProxyUrl: `${server.baseUrl}/proxy`,
    });
    const authB = new LoginAuth({
      baseUrl: server.baseUrl,
      storage: storageB,
      authProxyUrl: `${server.baseUrl}/proxy`,
    });

    const refresh = authA.refreshSession();
    while (!orderedMutations.includes("refresh:start")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    authB.signOut();

    expect(await refresh).toBeNull();
    await lockTail;
    expect(cookieLive).toBe(false);
    expect(storageA.getItem("steward_session_token")).toBeNull();
    expect(storageB.getItem("steward_session_token")).toBeNull();
    expect(orderedMutations).toEqual([
      "refresh:start",
      "refresh:rotated",
      "cookie:delete",
      "cookie:delete",
    ]);
  });

  test("a 401 from the proxy refresh signs out and clears the proxy cookie", async () => {
    await server?.close();
    server = await startServer((req) => {
      requests.push(req);
      if (req.path === "/proxy/refresh") {
        return {
          status: 401,
          json: { ok: false, error: "Invalid or expired refresh token" },
        };
      }
      return { json: { ok: true } };
    });
    const auth = new LoginAuth({
      baseUrl: requireLoginValue(server, "server").baseUrl,
      storage,
      authProxyUrl: `${requireLoginValue(server, "server").baseUrl}/proxy`,
    });
    storage.setItem("steward_session_token", fakeJwt());

    const session = await auth.refreshSession();

    expect(session).toBeNull();
    expect(storage.getItem("steward_session_token")).toBeNull();
    // signOut fires a best-effort cookie clear at the proxy.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      proxyRequests("/proxy/session", "DELETE").length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("switchTenant forwards only the tenantId to the proxy refresh", async () => {
    const auth = new LoginAuth({
      baseUrl: requireLoginValue(server, "server").baseUrl,
      storage,
      authProxyUrl: `${requireLoginValue(server, "server").baseUrl}/proxy`,
    });
    storage.setItem("steward_session_token", fakeJwt());

    const session = await auth.switchTenant("tenant-2");

    expect(session?.userId).toBe("user-2");
    const refreshes = proxyRequests("/proxy/refresh", "POST");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].bodyJson).toEqual({ tenantId: "tenant-2" });
  });

  test("revokeSession revokes via the proxy and clears local state", async () => {
    const auth = new LoginAuth({
      baseUrl: requireLoginValue(server, "server").baseUrl,
      storage,
      authProxyUrl: `${requireLoginValue(server, "server").baseUrl}/proxy`,
    });
    storage.setItem("steward_session_token", fakeJwt());

    await auth.revokeSession();

    expect(proxyRequests("/proxy/revoke", "POST")).toHaveLength(1);
    expect(storage.getItem("steward_session_token")).toBeNull();
  });

  test.each(["/auth/logout", "/proxy/revoke"])(
    "revokeSession reports a failed %s acknowledgement",
    async (failedPath) => {
      await server?.close();
      server = await startServer((request) =>
        request.path === failedPath
          ? {
              status: 503,
              json: { ok: false, error: "Revocation unavailable" },
            }
          : { json: { ok: true } },
      );
      const auth = new LoginAuth({
        baseUrl: server.baseUrl,
        storage,
        authProxyUrl: `${server.baseUrl}/proxy`,
      });
      storage.setItem("steward_session_token", fakeJwt());
      await expect(auth.revokeSession()).rejects.toThrow(
        "Revocation unavailable",
      );
    },
  );

  test("without authProxyUrl the refresh token still goes to storage (default unchanged)", async () => {
    const auth = new LoginAuth({
      baseUrl: requireLoginValue(server, "server").baseUrl,
      storage,
    });

    await auth.verifyEmailCallback("magic-token", "test@example.com");

    expect(storage.getItem("steward_refresh_token")).toBe("rt-secret-1");
    expect(proxyRequests("/proxy/session")).toHaveLength(0);
  });

  test("clears a rejected single-flight promise so a later refresh can retry", async () => {
    let lockAttempts = 0;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, callback: () => Promise<unknown>) => {
            lockAttempts += 1;
            if (lockAttempts === 1) throw new Error("synthetic lock failure");
            return await callback();
          },
        },
      },
    });
    const auth = new LoginAuth({
      baseUrl: requireLoginValue(server, "server").baseUrl,
      storage,
      authProxyUrl: `${requireLoginValue(server, "server").baseUrl}/proxy`,
    });
    storage.setItem("steward_session_token", fakeJwt());

    await expect(auth.refreshSession()).rejects.toThrow(
      "synthetic lock failure",
    );
    expect((await auth.refreshSession())?.userId).toBe("user-2");
    expect(lockAttempts).toBe(2);
    expect(proxyRequests("/proxy/refresh")).toHaveLength(1);
  });
});
