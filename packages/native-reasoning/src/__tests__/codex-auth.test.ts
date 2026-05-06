import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetCodexAuthDeps,
  __setCodexAuthDeps,
  type CodexAuth,
  defaultAuthPath,
  isExpired,
  loadCodexAuth,
  refreshCodexAuth,
  saveCodexAuth,
} from "../backends/codex-auth.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function b64url(input: object): string {
  return Buffer.from(JSON.stringify(input))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJwt(payload: object): string {
  const header = b64url({ alg: "RS256", typ: "JWT" });
  const body = b64url(payload);
  return `${header}.${body}.fake-sig`;
}

function makeAuth(overrides: Partial<CodexAuth> = {}): CodexAuth {
  return {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: "2025-01-01T00:00:00.000Z",
    tokens: {
      id_token: "id-token-fixture",
      access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "refresh-token-fixture",
      account_id: "acct_123",
    },
    ...overrides,
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codex-auth-test-"));
});
afterEach(async () => {
  __resetCodexAuthDeps();
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadCodexAuth
// ---------------------------------------------------------------------------

describe("loadCodexAuth", () => {
  it("reads and parses a fixture auth.json", async () => {
    const auth = makeAuth();
    const p = join(tmp, "auth.json");
    await writeFile(p, JSON.stringify(auth, null, 2));
    const loaded = await loadCodexAuth(p);
    expect(loaded.tokens.account_id).toBe("acct_123");
    expect(loaded.auth_mode).toBe("chatgpt");
  });

  it("normalizes missing OPENAI_API_KEY to null", async () => {
    const p = join(tmp, "auth.json");
    const partial = makeAuth();
    // drop OPENAI_API_KEY entirely from the on-disk file
    const obj = { ...partial } as Partial<CodexAuth>;
    delete obj.OPENAI_API_KEY;
    await writeFile(p, JSON.stringify(obj));
    const loaded = await loadCodexAuth(p);
    expect(loaded.OPENAI_API_KEY).toBeNull();
  });

  it("throws on malformed auth.json", async () => {
    const p = join(tmp, "auth.json");
    await writeFile(p, JSON.stringify({ tokens: { access_token: "x" } }));
    await expect(loadCodexAuth(p)).rejects.toThrow(/malformed/);
  });

  it("default path points at ~/.codex/auth.json", () => {
    expect(defaultAuthPath()).toMatch(/\.codex[\\/]auth\.json$/);
  });
});

// ---------------------------------------------------------------------------
// isExpired
// ---------------------------------------------------------------------------

describe("isExpired", () => {
  it("returns false for a token expiring well in the future", () => {
    const auth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "r",
        account_id: "a",
      },
    });
    expect(isExpired(auth)).toBe(false);
  });

  it("returns true for a token already past exp", () => {
    const auth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
        refresh_token: "r",
        account_id: "a",
      },
    });
    expect(isExpired(auth)).toBe(true);
  });

  it("returns true within the default 60s buffer", () => {
    const auth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 }),
        refresh_token: "r",
        account_id: "a",
      },
    });
    expect(isExpired(auth)).toBe(true);
  });

  it("respects a custom buffer", () => {
    const auth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 }),
        refresh_token: "r",
        account_id: "a",
      },
    });
    expect(isExpired(auth, 5)).toBe(false);
    expect(isExpired(auth, 60)).toBe(true);
  });

  it("returns true when access_token isn't a JWT", () => {
    const auth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: "not.a.jwt.at.all",
        refresh_token: "r",
        account_id: "a",
      },
    });
    // 5-segment string with non-base64 payload — payload b64 decodes to garbage,
    // JSON.parse throws → null payload → expired.
    expect(isExpired(auth)).toBe(true);
  });

  it("returns true when payload is missing exp", () => {
    const auth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ sub: "x" }),
        refresh_token: "r",
        account_id: "a",
      },
    });
    expect(isExpired(auth)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// saveCodexAuth (atomicity)
// ---------------------------------------------------------------------------

describe("saveCodexAuth", () => {
  it("writes the file with 600 perms and valid JSON", async () => {
    const p = join(tmp, "auth.json");
    const auth = makeAuth();
    await saveCodexAuth(auth, p);
    const st = await stat(p);
    // perms: low 9 bits should be rw-------
    expect(st.mode & 0o777).toBe(0o600);
    const round = JSON.parse(await readFile(p, "utf8"));
    expect(round.tokens.account_id).toBe("acct_123");
  });

  it("does not leave a tmp file behind on success", async () => {
    const p = join(tmp, "auth.json");
    await saveCodexAuth(makeAuth(), p);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tmp);
    const tmps = entries.filter((e) => e.includes(".tmp."));
    expect(tmps).toEqual([]);
  });

  it("partial file is never visible to readers (atomic rename)", async () => {
    // Write an "old" version, then race a save against repeated reads.
    const p = join(tmp, "auth.json");
    const oldAuth = makeAuth({
      tokens: {
        ...makeAuth().tokens,
        access_token: "OLD_TOKEN",
      },
    });
    await saveCodexAuth(oldAuth, p);

    const newAuth = makeAuth({
      tokens: { ...makeAuth().tokens, access_token: "NEW_TOKEN" },
    });

    // Hammer reads while a save is in flight; every read must be either
    // fully old or fully new.
    const savePromise = saveCodexAuth(newAuth, p);
    const readers = Array.from({ length: 50 }, async () => {
      const txt = await readFile(p, "utf8");
      const obj = JSON.parse(txt);
      return obj.tokens.access_token as string;
    });

    const observed = await Promise.all(readers);
    await savePromise;
    for (const t of observed) {
      expect(t === "OLD_TOKEN" || t === "NEW_TOKEN").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// refreshCodexAuth
// ---------------------------------------------------------------------------

describe("refreshCodexAuth", () => {
  it("posts form-urlencoded to the OAuth endpoint with correct shape", async () => {
    const p = join(tmp, "auth.json");
    const oldAuth = makeAuth({
      tokens: {
        id_token: "old-id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
        refresh_token: "OLD_REFRESH",
        account_id: "acct_xyz",
      },
    });
    await saveCodexAuth(oldAuth, p);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://auth.openai.com/oauth/token");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
      const body = init?.body as string;
      const params = new URLSearchParams(body);
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("OLD_REFRESH");
      expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");

      return new Response(
        JSON.stringify({
          access_token: makeJwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
          refresh_token: "NEW_REFRESH",
          id_token: "NEW_ID",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const fixedNow = Date.now();
    __setCodexAuthDeps({ fetch: fetchMock, now: () => fixedNow });

    const refreshed = await refreshCodexAuth(oldAuth, p);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshed.tokens.refresh_token).toBe("NEW_REFRESH");
    expect(refreshed.tokens.id_token).toBe("NEW_ID");
    expect(refreshed.tokens.account_id).toBe("acct_xyz"); // preserved
    expect(refreshed.last_refresh).toBe(new Date(fixedNow).toISOString());

    // File should now contain the refreshed tokens.
    const onDisk = JSON.parse(await readFile(p, "utf8"));
    expect(onDisk.tokens.refresh_token).toBe("NEW_REFRESH");
  });

  it("preserves old refresh_token if response omits it", async () => {
    const p = join(tmp, "auth.json");
    const oldAuth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
        refresh_token: "STAY",
        account_id: "a",
      },
    });
    await saveCodexAuth(oldAuth, p);

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 999 }),
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    __setCodexAuthDeps({ fetch: fetchMock });

    const out = await refreshCodexAuth(oldAuth, p);
    expect(out.tokens.refresh_token).toBe("STAY");
  });

  it("throws on non-2xx response", async () => {
    const p = join(tmp, "auth.json");
    const oldAuth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
        refresh_token: "OLD",
        account_id: "a",
      },
    });
    await saveCodexAuth(oldAuth, p);

    const fetchMock = vi.fn(
      async () => new Response("bad refresh", { status: 401 }),
    ) as unknown as typeof fetch;
    __setCodexAuthDeps({ fetch: fetchMock });

    await expect(refreshCodexAuth(oldAuth, p)).rejects.toThrow(
      /refresh failed/,
    );
  });

  it("skips the network call if another process already refreshed", async () => {
    const p = join(tmp, "auth.json");
    const expiredOnDisk = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
        refresh_token: "OLD",
        account_id: "a",
      },
    });

    // Initial state: a fresh token sits on disk (because peer just refreshed).
    const fresh = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "ALREADY_REFRESHED",
        account_id: "a",
      },
    });
    await saveCodexAuth(fresh, p);

    const fetchMock = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    __setCodexAuthDeps({ fetch: fetchMock });

    // Caller's in-memory copy still says "expired", but on-disk is fresh.
    const out = await refreshCodexAuth(expiredOnDisk, p);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.tokens.refresh_token).toBe("ALREADY_REFRESHED");
  });

  it("two concurrent refreshers serialize via the lock", async () => {
    const p = join(tmp, "auth.json");
    const oldAuth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
        refresh_token: "OLD",
        account_id: "a",
      },
    });
    await saveCodexAuth(oldAuth, p);

    // Track fetch concurrency: this MUST never exceed 1, because the lock
    // ensures only one process is in the critical section at a time.
    let inFlight = 0;
    let maxInFlight = 0;
    let counter = 0;

    const fetchMock = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => setTimeout(r, 30));
      inFlight--;
      counter++;
      return new Response(
        JSON.stringify({
          access_token: makeJwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
          refresh_token: `NEW_${counter}`,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    __setCodexAuthDeps({ fetch: fetchMock });

    const [a, b] = await Promise.all([
      refreshCodexAuth(oldAuth, p),
      refreshCodexAuth(oldAuth, p),
    ]);

    // Lock guarantees no concurrency.
    expect(maxInFlight).toBe(1);

    // First one acquires lock, refreshes, writes new fresh token. Second
    // acquires lock after release, re-reads from disk, sees fresh token,
    // skips network call. So we expect exactly 1 fetch.
    expect(counter).toBe(1);

    // Both returned a valid auth object.
    expect(a.tokens.access_token).toBeTruthy();
    expect(b.tokens.access_token).toBeTruthy();

    // Lock file should be cleaned up.
    await expect(stat(`${p}.lock`)).rejects.toThrow();
  });

  it("releases the lock on fetch failure", async () => {
    const p = join(tmp, "auth.json");
    const oldAuth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
        refresh_token: "OLD",
        account_id: "a",
      },
    });
    await saveCodexAuth(oldAuth, p);

    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    __setCodexAuthDeps({ fetch: fetchMock });

    await expect(refreshCodexAuth(oldAuth, p)).rejects.toThrow(/network/);
    await expect(stat(`${p}.lock`)).rejects.toThrow();
  });

  it("breaks a stale lock (>30s old) and proceeds", async () => {
    const p = join(tmp, "auth.json");
    const oldAuth = makeAuth({
      tokens: {
        id_token: "id",
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
        refresh_token: "OLD",
        account_id: "a",
      },
    });
    await saveCodexAuth(oldAuth, p);

    // Plant a stale lock (mtime well in the past).
    const lockPath = `${p}.lock`;
    await writeFile(lockPath, "99999\n");
    const { utimes } = await import("node:fs/promises");
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lockPath, longAgo, longAgo);

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: makeJwt({
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
            refresh_token: "POST_BREAK",
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    __setCodexAuthDeps({ fetch: fetchMock });

    const out = await refreshCodexAuth(oldAuth, p);
    expect(out.tokens.refresh_token).toBe("POST_BREAK");
    await expect(stat(lockPath)).rejects.toThrow();
  });
});
