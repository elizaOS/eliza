/**
 * Unit tests for the Eliza Cloud SSO helpers in `services/cloud-auth.ts`.
 *
 * Covers:
 *   - `getSsoRedirectUrl` builds an `${issuer}/oauth/authorize?...` URL with
 *     all required OAuth params and throws when `ELIZA_CLOUD_CLIENT_ID` is
 *     unset or `state` is empty.
 *   - `exchangeCodeForSession` happy path against a real RS256-signed
 *     id_token served by an inline HTTP server (token + JWKS endpoints).
 *   - State mismatch, missing env vars, and signature failures all throw —
 *     fail-closed, no partial-claims fallback.
 *
 * No SQL mocks. No mocking of the code under test. We mint real keys with
 * `jose`, run a real local HTTP server, and exercise the full code path.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exchangeCodeForSession, getSsoRedirectUrl } from "../../services/cloud-auth";
import type { CloudBootstrapService } from "../../services/cloud-bootstrap";

// ─── Test harness ──────────────────────────────────────────────────────────

interface Harness {
  issuer: string;
  jwksUrl: string;
  tokenUrl: string;
  realPrivate: CryptoKey;
  realPublicJwk: JWK;
  attackerPrivate: CryptoKey;
  /** Last token-endpoint request body, parsed as URL-encoded form data. */
  lastTokenRequestForm: URLSearchParams | null;
  /** Override what the token endpoint returns next. */
  setTokenResponse: (response: { status: number; body: Record<string, unknown> | string }) => void;
  bootstrap: CloudBootstrapService;
  cleanup: () => Promise<void>;
}

let server: http.Server;
let harness: Harness;

function bootstrapServiceFor(issuer: string, jwksUrl: string): CloudBootstrapService {
  return {
    getExpectedIssuer: () => issuer,
    getJwksUrl: () => jwksUrl,
    getRevocationListUrl: () => `${issuer}/.well-known/revocations.json`,
    getExpectedContainerId: () => null,
  };
}

async function open(): Promise<Harness> {
  const real = await generateKeyPair("RS256", { extractable: true });
  const attacker = await generateKeyPair("RS256", { extractable: true });
  const realPublicJwk = await exportJWK(real.publicKey);
  realPublicJwk.kid = "real-key";
  realPublicJwk.alg = "RS256";
  realPublicJwk.use = "sig";

  let nextTokenResponse: {
    status: number;
    body: Record<string, unknown> | string;
  } = {
    status: 200,
    body: { error: "no_response_set" },
  };
  let capturedForm: URLSearchParams | null = null;

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "/";
      if (url === "/.well-known/jwks.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [realPublicJwk] }));
        return;
      }
      if (url === "/oauth/token" && req.method === "POST") {
        const raw = Buffer.concat(chunks).toString("utf-8");
        capturedForm = new URLSearchParams(raw);
        const body =
          typeof nextTokenResponse.body === "string"
            ? nextTokenResponse.body
            : JSON.stringify(nextTokenResponse.body);
        res.writeHead(nextTokenResponse.status, {
          "content-type":
            typeof nextTokenResponse.body === "string" ? "text/plain" : "application/json",
        });
        res.end(body);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", url }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const issuer = `http://127.0.0.1:${port}`;
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  const tokenUrl = `${issuer}/oauth/token`;

  return {
    issuer,
    jwksUrl,
    tokenUrl,
    realPrivate: real.privateKey,
    realPublicJwk,
    attackerPrivate: attacker.privateKey,
    get lastTokenRequestForm() {
      return capturedForm;
    },
    setTokenResponse(response) {
      nextTokenResponse = response;
    },
    bootstrap: bootstrapServiceFor(issuer, jwksUrl),
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  } as Harness;
}

interface SignArgs {
  privateKey: CryptoKey;
  issuer: string;
  audience: string;
  sub?: string;
  email?: string;
  name?: string;
  exp?: number;
  iat?: number;
}

async function signIdToken(args: SignArgs): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: args.email ?? "user@example.com",
    name: args.name ?? "Eliza User",
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "real-key" })
    .setIssuer(args.issuer)
    .setSubject(args.sub ?? "cloud-user-1")
    .setAudience(args.audience)
    .setIssuedAt(args.iat ?? now)
    .setExpirationTime(args.exp ?? now + 600)
    .sign(args.privateKey);
}

const ENV_KEYS = [
  "ELIZA_CLOUD_CLIENT_ID",
  "ELIZA_CLOUD_CLIENT_SECRET",
  "ELIZA_CLOUD_ISSUER",
  "ELIZA_API_BIND",
  "ELIZA_API_PORT",
  "ELIZA_PORT",
  "ELIZA_UI_PORT",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  harness = await open();
});

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ─── getSsoRedirectUrl ─────────────────────────────────────────────────────

describe("getSsoRedirectUrl", () => {
  it("builds an authorize URL with all required OAuth params", () => {
    const url = getSsoRedirectUrl(harness.bootstrap, {
      state: "state-abc",
      env: {
        ELIZA_CLOUD_CLIENT_ID: "client-from-env",
        ELIZA_API_BIND: "127.0.0.1",
        ELIZA_API_PORT: "31337",
      },
    });
    const parsed = new URL(url);
    expect(`${parsed.protocol}//${parsed.host}`).toBe(harness.issuer);
    expect(parsed.pathname).toBe("/oauth/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("client-from-env");
    expect(parsed.searchParams.get("scope")).toBe("openid profile");
    expect(parsed.searchParams.get("state")).toBe("state-abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:31337/api/auth/login/sso/callback"
    );
  });

  it("forwards milady_return_to when provided", () => {
    const url = getSsoRedirectUrl(harness.bootstrap, {
      state: "state-abc",
      returnTo: "/onboarding/setup",
      env: {
        ELIZA_CLOUD_CLIENT_ID: "client-from-env",
        ELIZA_API_BIND: "127.0.0.1",
        ELIZA_API_PORT: "31337",
      },
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("milady_return_to")).toBe("/onboarding/setup");
  });

  it("prefers explicit clientId over env", () => {
    const url = getSsoRedirectUrl(harness.bootstrap, {
      state: "state-abc",
      clientId: "explicit-client",
      env: {
        ELIZA_CLOUD_CLIENT_ID: "client-from-env",
        ELIZA_API_BIND: "127.0.0.1",
        ELIZA_API_PORT: "31337",
      },
    });
    expect(new URL(url).searchParams.get("client_id")).toBe("explicit-client");
  });

  it("throws when ELIZA_CLOUD_CLIENT_ID is unset and no override is given", () => {
    expect(() =>
      getSsoRedirectUrl(harness.bootstrap, {
        state: "state-abc",
        env: { ELIZA_API_BIND: "127.0.0.1", ELIZA_API_PORT: "31337" },
      })
    ).toThrow(/ELIZA_CLOUD_CLIENT_ID is not configured/);
  });

  it("throws when state is empty", () => {
    expect(() =>
      getSsoRedirectUrl(harness.bootstrap, {
        state: "",
        env: {
          ELIZA_CLOUD_CLIENT_ID: "client-x",
          ELIZA_API_BIND: "127.0.0.1",
          ELIZA_API_PORT: "31337",
        },
      })
    ).toThrow(/state nonce/);
  });

  it("propagates the issuer fail-closed when the bootstrap throws", () => {
    const failing: CloudBootstrapService = {
      getExpectedIssuer: () => {
        throw new Error("ELIZA_CLOUD_ISSUER is not configured");
      },
      getJwksUrl: () => {
        throw new Error("ELIZA_CLOUD_ISSUER is not configured");
      },
      getRevocationListUrl: () => {
        throw new Error("ELIZA_CLOUD_ISSUER is not configured");
      },
      getExpectedContainerId: () => null,
    };
    expect(() =>
      getSsoRedirectUrl(failing, {
        state: "state-abc",
        env: {
          ELIZA_CLOUD_CLIENT_ID: "client-x",
          ELIZA_API_BIND: "127.0.0.1",
          ELIZA_API_PORT: "31337",
        },
      })
    ).toThrow(/ELIZA_CLOUD_ISSUER is not configured/);
  });
});

// ─── exchangeCodeForSession ────────────────────────────────────────────────

describe("exchangeCodeForSession", () => {
  function envFor(): Record<string, string> {
    return {
      ELIZA_CLOUD_CLIENT_ID: "client-x",
      ELIZA_CLOUD_CLIENT_SECRET: "secret-y",
      ELIZA_API_BIND: "127.0.0.1",
      ELIZA_API_PORT: "31337",
    };
  }

  it("happy path: returns a session for a valid id_token", async () => {
    const idToken = await signIdToken({
      privateKey: harness.realPrivate,
      issuer: harness.issuer,
      audience: "client-x",
      sub: "cloud-user-42",
      email: "alice@example.com",
      name: "Alice",
    });
    harness.setTokenResponse({
      status: 200,
      body: {
        id_token: idToken,
        access_token: "at-x",
        token_type: "Bearer",
        expires_in: 3600,
      },
    });
    const session = await exchangeCodeForSession({
      code: "auth-code-123",
      state: "state-abc",
      expectedState: "state-abc",
      bootstrap: harness.bootstrap,
      env: envFor(),
    });
    expect(session.cloudUserId).toBe("cloud-user-42");
    expect(session.email).toBe("alice@example.com");
    expect(session.displayName).toBe("Alice");
    expect(session.claims.iss).toBe(harness.issuer);
    expect(session.claims.email_verified).toBe(true);

    // Verify the request body the cloud token endpoint received.
    const form = harness.lastTokenRequestForm;
    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("code")).toBe("auth-code-123");
    expect(form?.get("client_id")).toBe("client-x");
    expect(form?.get("client_secret")).toBe("secret-y");
    expect(form?.get("redirect_uri")).toBe("http://127.0.0.1:31337/api/auth/login/sso/callback");
  });

  it("rejects when state does not match expectedState", async () => {
    await expect(
      exchangeCodeForSession({
        code: "c",
        state: "state-issued",
        expectedState: "state-other",
        bootstrap: harness.bootstrap,
        env: envFor(),
      })
    ).rejects.toThrow(/state mismatch/);
  });

  it("rejects when code is empty", async () => {
    await expect(
      exchangeCodeForSession({
        code: "",
        state: "s",
        expectedState: "s",
        bootstrap: harness.bootstrap,
        env: envFor(),
      })
    ).rejects.toThrow(/non-empty code/);
  });

  it("rejects when ELIZA_CLOUD_CLIENT_ID is unset", async () => {
    await expect(
      exchangeCodeForSession({
        code: "c",
        state: "s",
        expectedState: "s",
        bootstrap: harness.bootstrap,
        env: {
          ELIZA_CLOUD_CLIENT_SECRET: "secret-y",
          ELIZA_API_BIND: "127.0.0.1",
          ELIZA_API_PORT: "31337",
        },
      })
    ).rejects.toThrow(/ELIZA_CLOUD_CLIENT_ID is not configured/);
  });

  it("rejects when ELIZA_CLOUD_CLIENT_SECRET is unset", async () => {
    await expect(
      exchangeCodeForSession({
        code: "c",
        state: "s",
        expectedState: "s",
        bootstrap: harness.bootstrap,
        env: {
          ELIZA_CLOUD_CLIENT_ID: "client-x",
          ELIZA_API_BIND: "127.0.0.1",
          ELIZA_API_PORT: "31337",
        },
      })
    ).rejects.toThrow(/ELIZA_CLOUD_CLIENT_SECRET is not configured/);
  });

  it("rejects an id_token signed by an attacker key with the same kid", async () => {
    const idToken = await signIdToken({
      privateKey: harness.attackerPrivate,
      issuer: harness.issuer,
      audience: "client-x",
    });
    harness.setTokenResponse({
      status: 200,
      body: { id_token: idToken },
    });
    await expect(
      exchangeCodeForSession({
        code: "c",
        state: "s",
        expectedState: "s",
        bootstrap: harness.bootstrap,
        env: envFor(),
      })
    ).rejects.toThrow();
  });

  it("rejects an id_token with a wrong audience", async () => {
    const idToken = await signIdToken({
      privateKey: harness.realPrivate,
      issuer: harness.issuer,
      audience: "different-client",
    });
    harness.setTokenResponse({
      status: 200,
      body: { id_token: idToken },
    });
    await expect(
      exchangeCodeForSession({
        code: "c",
        state: "s",
        expectedState: "s",
        bootstrap: harness.bootstrap,
        env: envFor(),
      })
    ).rejects.toThrow();
  });

  it("rejects an id_token with a wrong issuer", async () => {
    const idToken = await signIdToken({
      privateKey: harness.realPrivate,
      issuer: "https://other.example",
      audience: "client-x",
    });
    harness.setTokenResponse({
      status: 200,
      body: { id_token: idToken },
    });
    await expect(
      exchangeCodeForSession({
        code: "c",
        state: "s",
        expectedState: "s",
        bootstrap: harness.bootstrap,
        env: envFor(),
      })
    ).rejects.toThrow();
  });

  it("rejects when the token endpoint returns a non-2xx status", async () => {
    harness.setTokenResponse({ status: 500, body: { error: "internal" } });
    await expect(
      exchangeCodeForSession({
        code: "c",
        state: "s",
        expectedState: "s",
        bootstrap: harness.bootstrap,
        env: envFor(),
      })
    ).rejects.toThrow(/HTTP 500/);
  });

  it("rejects when the token endpoint returns no id_token", async () => {
    harness.setTokenResponse({
      status: 200,
      body: { access_token: "at-x" },
    });
    await expect(
      exchangeCodeForSession({
        code: "c",
        state: "s",
        expectedState: "s",
        bootstrap: harness.bootstrap,
        env: envFor(),
      })
    ).rejects.toThrow(/did not return an id_token/);
  });

  it("rejects when the id_token is missing the email claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      name: "No Email User",
    })
      .setProtectedHeader({ alg: "RS256", kid: "real-key" })
      .setIssuer(harness.issuer)
      .setSubject("cloud-user-99")
      .setAudience("client-x")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(harness.realPrivate);
    harness.setTokenResponse({
      status: 200,
      body: { id_token: idToken },
    });
    await expect(
      exchangeCodeForSession({
        code: "c",
        state: "s",
        expectedState: "s",
        bootstrap: harness.bootstrap,
        env: envFor(),
      })
    ).rejects.toThrow(/missing email/);
  });
});
