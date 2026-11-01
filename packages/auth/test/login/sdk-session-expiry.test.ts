/**
 * Session-expiry rotation contract for the browser SDK's LoginAuth client.
 *
 * An expired 15-minute access token is the normal end of the token's life, not
 * a sign-out: the 30-day rotating refresh credential must survive so rotation
 * can recover the session (PR-opened regression guard — before the fix, the
 * first expired read wiped the refresh credential before any rotation).
 *
 * The refresh requests below travel over a real loopback HTTP socket to a
 * local login backend that mirrors the production POST /auth/refresh
 * envelope ({ ok, token, refreshToken, expiresIn }); no SDK mocks.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LoginAuth } from "../../src/sdk/auth.js";

const ACCESS_KEY = "steward_session_token";
const REFRESH_KEY = "steward_refresh_token";
const ORIGINAL_REFRESH = "valid-30-day-refresh";

class MapStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

function b64u(payload: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function expiredAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  return `x.${b64u({
    userId: "u-expiry-guard",
    tenantId: "t-expiry-guard",
    iat: now - 2000,
    exp: now - 900,
  })}.y`;
}

function livingAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  return `x.${b64u({
    userId: "u-expiry-guard",
    tenantId: "t-expiry-guard",
    iat: now,
    exp: now + 3600,
  })}.y`;
}

interface Backend {
  url: string;
  requests: { path: string; refreshToken: unknown }[];
  closeAll: () => Promise<void>;
}

function startBackend(mode: "recover" | "reject"): Promise<Backend> {
  const requests: { path: string; refreshToken: unknown }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
          : {};
      } catch {
        parsed = {};
      }
      const path = req.url ?? "";
      requests.push({ path, refreshToken: parsed.refreshToken });
      if (!path.includes("/auth/refresh")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      if (mode === "reject") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "Invalid or expired refresh token",
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          token: livingAccessToken(),
          refreshToken: "rotated-refresh",
          expiresIn: 900,
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        closeAll: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
    server.unref();
  });
}

function makeAuth(
  storage: MapStorage,
  backend: Backend,
  onSessionChange?: (session: unknown) => void,
) {
  return new LoginAuth({
    baseUrl: backend.url,
    storage,
    allowInsecureBaseUrl: true,
    ...(onSessionChange ? { onSessionChange } : {}),
  });
}

const opened: Backend[] = [];
beforeAll(() => {
  expect(true).toBe(true);
});
afterAll(async () => {
  await Promise.all(opened.map((backend) => backend.closeAll()));
});

async function openedBackend(mode: "recover" | "reject"): Promise<Backend> {
  const backend = await startBackend(mode);
  opened.push(backend);
  return backend;
}

describe("login SDK session expiry rotation", () => {
  it("returns a living session untouched", async () => {
    const backend = await openedBackend("recover");
    const storage = new MapStorage();
    storage.setItem(ACCESS_KEY, livingAccessToken());
    storage.setItem(REFRESH_KEY, ORIGINAL_REFRESH);
    const auth = makeAuth(storage, backend);
    const session = auth.getSession();
    expect(session?.token).toContain(".");
    expect(auth.getRefreshToken()).toBe(ORIGINAL_REFRESH);
    expect(backend.requests).toHaveLength(0);
  });

  it("keeps the refresh credential when the access token expires and recovers the session by rotation", async () => {
    const backend = await openedBackend("recover");
    const storage = new MapStorage();
    storage.setItem(ACCESS_KEY, expiredAccessToken());
    storage.setItem(REFRESH_KEY, ORIGINAL_REFRESH);
    const auth = makeAuth(storage, backend);

    // The expired access token yields no session, but the credential survives.
    expect(auth.getSession()).toBeNull();
    expect(auth.getRefreshToken()).toBe(ORIGINAL_REFRESH);

    // The SDK sends one rotation over the wire with the surviving credential.
    await vi.waitFor(() => {
      expect(backend.requests.map((r) => r.path)).toContain("/auth/refresh");
    });
    expect(
      backend.requests.find((r) => r.path.includes("/auth/refresh"))
        ?.refreshToken,
    ).toBe(ORIGINAL_REFRESH);

    // Rotation lands: the stored pair is replaced and the session recovers.
    await vi.waitFor(() => {
      expect(auth.getRefreshToken()).toBe("rotated-refresh");
    });
    const recovered = auth.getSession();
    expect(recovered?.token).toBeDefined();
    expect((recovered?.expiresAt ?? 0) * 1000).toBeGreaterThan(Date.now());
  });

  it("signs out with a notification when the server rejects the credential", async () => {
    const backend = await openedBackend("reject");
    const storage = new MapStorage();
    storage.setItem(ACCESS_KEY, expiredAccessToken());
    storage.setItem(REFRESH_KEY, "revoked-refresh");
    const notifications: (unknown | null)[] = [];
    const auth = makeAuth(storage, backend, (session) => {
      notifications.push(session);
    });

    auth.getSession();
    await vi.waitFor(() => {
      expect(notifications).toContain(null);
    });
    expect(storage.getItem(ACCESS_KEY)).toBeNull();
    expect(storage.getItem(REFRESH_KEY)).toBeNull();
    expect(auth.getSession()).toBeNull();
  });

  it("clears a dead access-only session without a rotation attempt", async () => {
    const backend = await openedBackend("recover");
    const storage = new MapStorage();
    storage.setItem(ACCESS_KEY, expiredAccessToken());
    const auth = makeAuth(storage, backend);

    expect(auth.getSession()).toBeNull();
    expect(auth.getRefreshToken()).toBeNull();
    expect(storage.getItem(ACCESS_KEY)).toBeNull();
    expect(backend.requests).toHaveLength(0);
  });
});
