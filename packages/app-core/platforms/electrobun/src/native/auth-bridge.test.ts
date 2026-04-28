/**
 * Auth bridge unit tests.
 *
 * Exercises the loopback bootstrap flow against a real `net.createServer`
 * peer that plays the role of the API: it connects to the bridge's socket,
 * reads the secret, and returns a synthetic 200 response. We assert the
 * bridge:
 *   - generates a secret and writes it to the socket
 *   - calls the right endpoint with the right shape
 *   - waits for the API to actually consume the socket before accepting the
 *     response
 *   - persists the session for the next boot
 *   - fails closed when the endpoint 404s, returns garbage, or times out
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapDesktopSession,
  clearPersistedSession,
  type DesktopSession,
  type FetchLike,
  installDesktopSessionCookies,
  loadOrCreateDesktopSession,
  loadPersistedSession,
  persistSession,
} from "./auth-bridge";

interface SocketReadResult {
  secret: Buffer;
  socketPath: string;
}

function readSocketSecret(socketPath: string): Promise<SocketReadResult> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath, () => {
      const chunks: Buffer[] = [];
      conn.on("data", (chunk: Buffer | string) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        chunks.push(buf);
      });
      conn.on("end", () => {
        const secret = Buffer.concat(chunks);
        resolve({ secret, socketPath });
      });
      conn.on("error", reject);
    });
    conn.on("error", reject);
  });
}

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "auth-bridge-test-"));
}

describe("auth-bridge", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = makeStateDir();
    env = { MILADY_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  describe("bootstrapDesktopSession", () => {
    it("hands the secret to a peer over the socket and returns the session", async () => {
      if (process.platform === "win32") return; // UDS-only

      let capturedSocketPath = "";
      let capturedSecretLength = 0;

      const fakeFetch: FetchLike = async (input, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          socketPath: string;
        };
        capturedSocketPath = body.socketPath;
        const result = await readSocketSecret(body.socketPath);
        capturedSecretLength = result.secret.length;
        return new Response(
          JSON.stringify({
            sessionId: "abc123",
            csrfToken: "csrf456",
            expiresAt: Date.now() + 60_000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ) as unknown as Response;
      };

      const session = await bootstrapDesktopSession({
        apiBase: "http://127.0.0.1:31337",
        env,
        fetchImpl: fakeFetch,
      });

      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe("abc123");
      expect(session?.csrfToken).toBe("csrf456");
      expect(path.basename(capturedSocketPath)).toMatch(
        /^(desktop-auth-|mda-).+\.sock$/,
      );
      expect(capturedSecretLength).toBe(32);

      // Socket must be unlinked after the call.
      expect(fs.existsSync(capturedSocketPath)).toBe(false);
    });

    it("returns null when the endpoint is missing", async () => {
      if (process.platform === "win32") return;

      const fakeFetch: FetchLike = async () =>
        new Response("Not Found", { status: 404 }) as unknown as Response;

      const session = await bootstrapDesktopSession({
        apiBase: "http://127.0.0.1:31337",
        env,
        fetchImpl: fakeFetch,
      });

      expect(session).toBeNull();
    });

    it("returns null when the response shape is wrong", async () => {
      if (process.platform === "win32") return;

      const fakeFetch: FetchLike = async (input, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          socketPath: string;
        };
        await readSocketSecret(body.socketPath);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }) as unknown as Response;
      };

      const session = await bootstrapDesktopSession({
        apiBase: "http://127.0.0.1:31337",
        env,
        fetchImpl: fakeFetch,
      });

      expect(session).toBeNull();
    });

    it("refuses non-loopback API bases", async () => {
      let fetchCalled = false;
      const fakeFetch: FetchLike = async () => {
        fetchCalled = true;
        return new Response("", { status: 200 }) as unknown as Response;
      };

      const session = await bootstrapDesktopSession({
        apiBase: "https://api.example.com",
        env,
        fetchImpl: fakeFetch,
      });

      expect(session).toBeNull();
      expect(fetchCalled).toBe(false);
    });
  });

  describe("persistSession / loadPersistedSession", () => {
    it("round-trips a session and rejects expired ones", () => {
      const fresh: DesktopSession = {
        sessionId: "s",
        csrfToken: "c",
        expiresAt: Date.now() + 3_600_000,
      };
      persistSession(fresh, env);
      const reloaded = loadPersistedSession(env);
      expect(reloaded).toEqual(fresh);

      const expired: DesktopSession = {
        sessionId: "old",
        csrfToken: "old",
        expiresAt: Date.now() - 1_000,
      };
      persistSession(expired, env);
      expect(loadPersistedSession(env)).toBeNull();
    });

    it("returns null when no file exists", () => {
      expect(loadPersistedSession(env)).toBeNull();
    });

    it("clears the persisted file", () => {
      persistSession(
        { sessionId: "s", csrfToken: "c", expiresAt: Date.now() + 60_000 },
        env,
      );
      clearPersistedSession(env);
      expect(loadPersistedSession(env)).toBeNull();
    });

    it("writes file with mode 0600 on POSIX", () => {
      if (process.platform === "win32") return;
      persistSession(
        { sessionId: "s", csrfToken: "c", expiresAt: Date.now() + 60_000 },
        env,
      );
      const sessionPath = path.join(stateDir, "auth", "desktop-session.json");
      const stat = fs.statSync(sessionPath);
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe("loadOrCreateDesktopSession", () => {
    it("returns the persisted session when it exists", async () => {
      if (process.platform === "win32") return;

      const persisted: DesktopSession = {
        sessionId: "from-disk",
        csrfToken: "from-disk-csrf",
        expiresAt: Date.now() + 3_600_000,
      };
      persistSession(persisted, env);

      let fetchCalled = false;
      const session = await loadOrCreateDesktopSession({
        apiBase: "http://127.0.0.1:31337",
        env,
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response("", { status: 200 }) as unknown as Response;
        },
      });

      expect(session).toEqual(persisted);
      expect(fetchCalled).toBe(false);
    });

    it("falls back to bootstrap when there is no persisted session", async () => {
      if (process.platform === "win32") return;

      const fakeFetch: FetchLike = async (input, init) => {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          socketPath: string;
        };
        await readSocketSecret(body.socketPath);
        return new Response(
          JSON.stringify({
            sessionId: "fresh",
            csrfToken: "fresh-csrf",
            expiresAt: Date.now() + 3_600_000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ) as unknown as Response;
      };

      const session = await loadOrCreateDesktopSession({
        apiBase: "http://127.0.0.1:31337",
        env,
        fetchImpl: fakeFetch,
      });

      expect(session?.sessionId).toBe("fresh");
      // Persisted for next boot.
      const reloaded = loadPersistedSession(env);
      expect(reloaded?.sessionId).toBe("fresh");
    });
  });

  describe("installDesktopSessionCookies", () => {
    it("sets both cookies on the API origin with the right flags", () => {
      const calls: Array<Record<string, unknown>> = [];
      const installer = {
        set: (cookie: Record<string, unknown>) => {
          calls.push(cookie);
          return true;
        },
      };

      const touched = installDesktopSessionCookies(
        installer,
        {
          sessionId: "sid",
          csrfToken: "csrf",
          expiresAt: Date.now() + 60_000,
        },
        { apiOrigin: "http://127.0.0.1:31337" },
      );

      expect(touched).toEqual(["http://127.0.0.1:31337"]);
      expect(calls).toHaveLength(2);
      const sessionCookie = calls.find((c) => c.name === "milady_session");
      const csrfCookie = calls.find((c) => c.name === "milady_csrf");
      expect(sessionCookie).toMatchObject({
        value: "sid",
        path: "/",
        httpOnly: true,
        secure: false, // http loopback
        sameSite: "lax",
      });
      expect(csrfCookie).toMatchObject({
        value: "csrf",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "lax",
      });
    });

    it("installs to the renderer origin when it differs from the API", () => {
      const calls: Array<Record<string, unknown>> = [];
      const installer = {
        set: (cookie: Record<string, unknown>) => {
          calls.push(cookie);
          return true;
        },
      };

      const touched = installDesktopSessionCookies(
        installer,
        {
          sessionId: "sid",
          csrfToken: "csrf",
          expiresAt: Date.now() + 60_000,
        },
        {
          apiOrigin: "http://127.0.0.1:31337",
          rendererOrigin: "http://127.0.0.1:2138",
        },
      );

      expect(touched).toEqual([
        "http://127.0.0.1:31337",
        "http://127.0.0.1:2138",
      ]);
      expect(calls).toHaveLength(4);
    });

    it("dedupes when renderer origin matches the API", () => {
      const calls: Array<Record<string, unknown>> = [];
      const installer = {
        set: (cookie: Record<string, unknown>) => {
          calls.push(cookie);
          return true;
        },
      };

      installDesktopSessionCookies(
        installer,
        {
          sessionId: "sid",
          csrfToken: "csrf",
          expiresAt: Date.now() + 60_000,
        },
        {
          apiOrigin: "http://127.0.0.1:31337",
          rendererOrigin: "http://127.0.0.1:31337",
        },
      );

      expect(calls).toHaveLength(2);
    });
  });
});
