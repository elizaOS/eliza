/**
 * Verifies OpenAI Codex OAuth flow, callback state matching, code-exchange
 * contracts, and token refresh lifecycle at the network and prompt boundaries.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loginOpenAICodex,
  refreshOpenAICodexToken,
} from "./openai-codex-login.ts";

/** Unsigned JWT carrying the chatgpt_account_id claim getAccountId reads. */
function fakeAccessToken(accountId = "acct-123"): string {
  const payload = btoa(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  );
  return `header.${payload}.sig`;
}

function mockTokenResponse(body: unknown, ok = true) {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) => {
      return {
        ok,
        status: ok ? 200 : 400,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("refreshOpenAICodexToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns rotated refresh token, accountId, and id_token from the response", async () => {
    mockTokenResponse({
      access_token: fakeAccessToken(),
      refresh_token: "rt-new",
      expires_in: 3600,
      id_token: "idt-new",
    });
    const creds = await refreshOpenAICodexToken("rt-old");
    expect(creds.refresh).toBe("rt-new");
    expect(creds.accountId).toBe("acct-123");
    expect(creds.idToken).toBe("idt-new");
    expect(creds.expires).toBeGreaterThan(Date.now());
  });

  it("keeps the current refresh token when the response omits refresh_token (RFC 6749 §6)", async () => {
    mockTokenResponse({
      access_token: fakeAccessToken(),
      expires_in: 3600,
    });
    const creds = await refreshOpenAICodexToken("rt-old");
    expect(creds.refresh).toBe("rt-old");
    expect(creds.access).toBe(fakeAccessToken());
  });

  it("fails when the response lacks an access token", async () => {
    mockTokenResponse({ refresh_token: "rt-new", expires_in: 3600 });
    await expect(refreshOpenAICodexToken("rt-old")).rejects.toThrow(
      /Failed to refresh OpenAI Codex token/,
    );
  });

  it("fails when the refreshed access token does not contain a valid accountId", async () => {
    mockTokenResponse({
      access_token: "header.e30.sig", // payload is {}
      refresh_token: "rt-new",
      expires_in: 3600,
    });
    await expect(refreshOpenAICodexToken("rt-old")).rejects.toThrow(
      /Failed to extract accountId from token/,
    );
  });

  it("fails when the refresh endpoint returns non-OK with an otherwise-valid body", async () => {
    // The body is fully valid so only the !response.ok branch can reject;
    // mutating that check to always-accept must fail this test.
    mockTokenResponse(
      {
        access_token: fakeAccessToken(),
        refresh_token: "rt-new",
        expires_in: 3600,
      },
      false,
    );
    await expect(refreshOpenAICodexToken("rt-old")).rejects.toThrow(
      /Failed to refresh OpenAI Codex token/,
    );
  });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Loopback binding probe: sandboxed runners forbid listen() entirely, in
 * which case the port-dependent tests below skip loudly instead of failing.
 */
async function canBindLoopback(): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

/** Occupy :1455 so startLocalOAuthServer takes the bind-failure fallback. */
async function occupyCallbackPort() {
  const http = await import("node:http");
  const blocker = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(1455, "127.0.0.1", () => resolve());
      });
      return blocker;
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(100);
    }
  }
}

async function closeServer(server: { close: (cb?: () => void) => void }) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Real HTTP against the loopback server (global fetch is stubbed in-suite). */
async function getCallback(path: string) {
  const http = await import("node:http");
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    http
      .get(`http://127.0.0.1:1455${path}`, (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: data }),
        );
      })
      .on("error", reject);
  });
}

describe("loginOpenAICodex", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges code for credentials via manual URL input", async () => {
    mockTokenResponse({
      access_token: fakeAccessToken("acct-login-1"),
      refresh_token: "rt-login-1",
      expires_in: 3600,
      id_token: "idt-login-1",
    });

    let emittedUrl = "";
    const creds = await loginOpenAICodex({
      onAuth: (info) => {
        emittedUrl = info.url;
      },
      onPrompt: vi.fn(async () => ""),
      onManualCodeInput: async () => {
        const state = new URL(emittedUrl).searchParams.get("state") ?? "";
        return `http://localhost:1455/auth/callback?code=auth-code-123&state=${state}`;
      },
    });

    expect(creds.access).toBe(fakeAccessToken("acct-login-1"));
    expect(creds.refresh).toBe("rt-login-1");
    expect(creds.accountId).toBe("acct-login-1");
    expect(creds.idToken).toBe("idt-login-1");
    expect(creds.expires).toBeGreaterThan(Date.now());
  });

  it("exchanges code for credentials via manual code#state input", async () => {
    mockTokenResponse({
      access_token: fakeAccessToken("acct-login-2"),
      refresh_token: "rt-login-2",
      expires_in: 3600,
    });

    let emittedUrl = "";
    const creds = await loginOpenAICodex({
      onAuth: (info) => {
        emittedUrl = info.url;
      },
      onPrompt: vi.fn(async () => ""),
      onManualCodeInput: async () => {
        const state = new URL(emittedUrl).searchParams.get("state") ?? "";
        return `auth-code-456#${state}`;
      },
    });

    expect(creds.accountId).toBe("acct-login-2");
    expect(creds.access).toBe(fakeAccessToken("acct-login-2"));
  });

  it("exchanges code for credentials via manual URL query string format", async () => {
    const fetchMock = mockTokenResponse({
      access_token: fakeAccessToken("acct-login-3"),
      refresh_token: "rt-login-3",
      expires_in: 3600,
    });

    let emittedUrl = "";
    const creds = await loginOpenAICodex({
      onAuth: (info) => {
        emittedUrl = info.url;
      },
      onPrompt: vi.fn(async () => ""),
      onManualCodeInput: async () => {
        const state = new URL(emittedUrl).searchParams.get("state") ?? "";
        return `code=auth-code-789&state=${state}`;
      },
    });

    expect(creds.accountId).toBe("acct-login-3");
    expect(creds.access).toBe(fakeAccessToken("acct-login-3"));

    // Verify token endpoint was invoked with code extracted from the query string
    expect(fetchMock).toHaveBeenCalled();
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe("https://auth.openai.com/oauth/token");
    const params = new URLSearchParams(calledInit.body as string);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("auth-code-789");
    expect(params.get("code_verifier")).toBeTruthy();
    expect(params.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    );
  });

  it("rejects when the manual input state parameter mismatches the flow state", async () => {
    mockTokenResponse({
      access_token: fakeAccessToken(),
      refresh_token: "rt-new",
      expires_in: 3600,
    });

    await expect(
      loginOpenAICodex({
        onAuth: () => {},
        onPrompt: vi.fn(async () => ""),
        onManualCodeInput: async () =>
          "http://localhost:1455/auth/callback?code=abc&state=wrong-state",
      }),
    ).rejects.toThrow(/State mismatch/);
  });

  it("fails when token exchange endpoint returns an error", async () => {
    mockTokenResponse(
      {
        access_token: fakeAccessToken("acct-err"),
        refresh_token: "rt-e",
        expires_in: 3600,
      },
      false,
    );

    let emittedUrl = "";
    await expect(
      loginOpenAICodex({
        onAuth: (info) => {
          emittedUrl = info.url;
        },
        onPrompt: vi.fn(async () => ""),
        onManualCodeInput: async () => {
          const state = new URL(emittedUrl).searchParams.get("state") ?? "";
          return `code-xyz#${state}`;
        },
      }),
    ).rejects.toThrow(/Token exchange failed/);
  });

  it("fails when the exchanged token is missing chatgpt_account_id", async () => {
    mockTokenResponse({
      access_token: "header.e30.sig", // no account_id
      refresh_token: "rt-new",
      expires_in: 3600,
    });

    let emittedUrl = "";
    await expect(
      loginOpenAICodex({
        onAuth: (info) => {
          emittedUrl = info.url;
        },
        onPrompt: vi.fn(async () => ""),
        onManualCodeInput: async () => {
          const state = new URL(emittedUrl).searchParams.get("state") ?? "";
          return `code-xyz#${state}`;
        },
      }),
    ).rejects.toThrow(/Failed to extract accountId from token/);
  });

  it("serves the real local callback: wrong state is rejected, correct state completes login", async (ctx) => {
    if (!(await canBindLoopback())) {
      ctx.skip();
      return;
    }
    mockTokenResponse({
      access_token: fakeAccessToken("acct-callback"),
      refresh_token: "rt-callback",
      expires_in: 3600,
    });

    let emittedUrl = "";
    const loginPromise = loginOpenAICodex({
      onAuth: (info) => {
        emittedUrl = info.url;
      },
      onPrompt: () => {
        throw new Error("must not fall back to prompt on the live server");
      },
    });
    // onAuth fires after the server binds; the state check below is the
    // callback-server branch, not the manual-input one.
    while (!emittedUrl) await sleep(10);
    const state = new URL(emittedUrl).searchParams.get("state") ?? "";

    const bad = await getCallback(
      `/auth/callback?code=attacker-code&state=wrong-state`,
    );
    expect(bad.status).toBe(400);
    expect(bad.text).toBe("State mismatch");

    await getCallback(`/auth/callback?code=callback-code-1&state=${state}`);
    const creds = await loginPromise;
    expect(creds.accountId).toBe("acct-callback");
  });

  it("rejects mismatched state when the port-bound fallback resolves manual input late", async (ctx) => {
    if (!(await canBindLoopback())) {
      ctx.skip();
      return;
    }
    const blocker = await occupyCallbackPort();
    try {
      mockTokenResponse({
        access_token: fakeAccessToken(),
        refresh_token: "rt-new",
        expires_in: 3600,
      });

      // The failed bind resolves waitForCode before the delayed manual input
      // arrives, so this exercises the second state comparison, not the first.
      await expect(
        loginOpenAICodex({
          onAuth: () => {},
          onPrompt: vi.fn(async () => ""),
          onManualCodeInput: async () => {
            await sleep(50);
            return "http://localhost:1455/auth/callback?code=abc&state=wrong-state";
          },
        }),
      ).rejects.toThrow(/State mismatch/);
    } finally {
      await closeServer(blocker);
    }
  });

  it("rejects mismatched state from the onPrompt fallback when no callback arrives", async (ctx) => {
    if (!(await canBindLoopback())) {
      ctx.skip();
      return;
    }
    const blocker = await occupyCallbackPort();
    try {
      mockTokenResponse({
        access_token: fakeAccessToken(),
        refresh_token: "rt-new",
        expires_in: 3600,
      });

      await expect(
        loginOpenAICodex({
          onAuth: () => {},
          onPrompt: async () =>
            "http://localhost:1455/auth/callback?code=abc&state=wrong-state",
        }),
      ).rejects.toThrow(/State mismatch/);
    } finally {
      await closeServer(blocker);
    }
  });

  it("emits fresh unpredictable state per authorization flow", async () => {
    mockTokenResponse({
      access_token: fakeAccessToken(),
      refresh_token: "rt-new",
      expires_in: 3600,
    });

    const states: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      let emittedUrl = "";
      await loginOpenAICodex({
        onAuth: (info) => {
          emittedUrl = info.url;
        },
        onPrompt: vi.fn(async () => ""),
        onManualCodeInput: async () => {
          const state =
            new URL(emittedUrl).searchParams.get("state") ?? "";
          return `code-entropy-${i}#${state}`;
        },
      });
      states.push(new URL(emittedUrl).searchParams.get("state") ?? "");
    }

    // 16 random bytes hex-encoded; a constant or short state fails both.
    expect(states[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(states[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(states[0]).not.toBe(states[1]);
  });
});
