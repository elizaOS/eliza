/** Hosts a protocol-faithful OAuth, HTTP, and webhook provider for adapter tests. */

import { createHash, createHmac } from "node:crypto";
import { startFetchServer } from "../fetch-server.js";
import type {
  ProviderActionReceipt,
  ProviderProtocolFault,
  ProviderProtocolFixture,
  RecordedProviderRequest,
} from "./types.js";

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  organizationId: string;
  used: boolean;
}

interface Credential {
  accessToken: string;
  refreshToken: string;
  organizationId: string;
  expiresAt: number;
  active: boolean;
}

export interface FakeProviderOptions {
  fixtures?: readonly ProviderProtocolFixture[];
  clientId?: string;
  now?: () => number;
  tokenLifetimeMs?: number;
  seed?: string;
}

export interface FakeWebhookEvent {
  id: string;
  sequence: number;
  type: string;
  data: unknown;
}

export interface RunningFakeProvider {
  url: string;
  oauthAuthorizeUrl: string;
  oauthTokenUrl: string;
  requests: RecordedProviderRequest[];
  receipts: ProviderActionReceipt[];
  createConnectionId(): string;
  enqueueFault(
    method: string,
    path: string,
    fault: ProviderProtocolFault,
  ): void;
  expireAccessToken(accessToken: string): void;
  revokeRefreshToken(refreshToken: string): void;
  deliverWebhooks(
    targetUrl: string,
    events: readonly FakeWebhookEvent[],
    secret: string,
  ): Promise<Response[]>;
  recordAction(
    action: string,
    effect: ProviderActionReceipt["effect"],
    allowed: boolean,
  ): ProviderActionReceipt;
  /** Abruptly closes the upstream so the real adapter observes a network fault. */
  resetConnections(): Promise<void>;
  stop(): Promise<void>;
}

export async function startFakeProvider(
  options: FakeProviderOptions = {},
): Promise<RunningFakeProvider> {
  const fixtures = new Map(
    (options.fixtures ?? []).map((fixture) => [
      `${fixture.method} ${fixture.path}`,
      fixture,
    ]),
  );
  const clientId = options.clientId ?? "contract-client";
  const now = options.now ?? Date.now;
  const tokenLifetimeMs = options.tokenLifetimeMs ?? 3_600_000;
  const seed = options.seed ?? "eliza-provider-contract-v1";
  const authorizationCodes = new Map<string, AuthorizationCode>();
  const credentialsByAccess = new Map<string, Credential>();
  const credentialsByRefresh = new Map<string, Credential>();
  const faults = new Map<string, ProviderProtocolFault[]>();
  const requests: RecordedProviderRequest[] = [];
  const receipts: ProviderActionReceipt[] = [];
  let sequence = 0;

  const server = await startFetchServer(async (request) => {
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : await request.text();
    requests.push({
      method: request.method,
      path: url.pathname,
      query: redactEntries(url.searchParams),
      headers: redactHeaders(request.headers),
      body: redactText(body),
    });

    const faultKey = `${request.method} ${url.pathname}`;
    const queued = faults.get(faultKey);
    const fault = queued?.shift();
    if (fault) return applyFault(fault);

    if (url.pathname === "/oauth/authorize" && request.method === "GET") {
      const responseType = url.searchParams.get("response_type");
      const requestedClientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      const challengeMethod = url.searchParams.get("code_challenge_method");
      if (
        responseType !== "code" ||
        requestedClientId !== clientId ||
        !redirectUri ||
        !state ||
        !challenge ||
        challengeMethod !== "S256"
      ) {
        return oauthError("invalid_request", 400);
      }
      const code = opaque("code", seed, ++sequence);
      authorizationCodes.set(code, {
        clientId,
        redirectUri,
        challenge,
        organizationId: url.searchParams.get("organization_id") ?? "org-1",
        used: false,
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      return Response.redirect(callback.toString(), 302);
    }

    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const form = new URLSearchParams(body ?? "");
      const grantType = form.get("grant_type");
      if (grantType === "authorization_code") {
        const code = form.get("code");
        const entry = code ? authorizationCodes.get(code) : undefined;
        const verifier = form.get("code_verifier") ?? "";
        if (
          !entry ||
          entry.used ||
          form.get("client_id") !== entry.clientId ||
          form.get("redirect_uri") !== entry.redirectUri ||
          pkceChallenge(verifier) !== entry.challenge
        ) {
          return oauthError("invalid_grant", 400);
        }
        entry.used = true;
        const credential = issueCredential(
          entry.organizationId,
          seed,
          ++sequence,
          now() + tokenLifetimeMs,
        );
        credentialsByAccess.set(credential.accessToken, credential);
        credentialsByRefresh.set(credential.refreshToken, credential);
        return tokenResponse(credential, tokenLifetimeMs);
      }
      if (grantType === "refresh_token") {
        const refreshToken = form.get("refresh_token");
        const prior = refreshToken
          ? credentialsByRefresh.get(refreshToken)
          : undefined;
        if (prior === undefined) {
          return oauthError("invalid_grant", 400);
        }
        if (!prior.active || prior.expiresAt <= now()) {
          return oauthError("invalid_grant", 400);
        }
        prior.active = false;
        const credential = issueCredential(
          prior.organizationId,
          seed,
          ++sequence,
          now() + tokenLifetimeMs,
        );
        credentialsByAccess.set(credential.accessToken, credential);
        credentialsByRefresh.set(credential.refreshToken, credential);
        return tokenResponse(credential, tokenLifetimeMs);
      }
      return oauthError("unsupported_grant_type", 400);
    }

    if (url.pathname === "/oauth/revoke" && request.method === "POST") {
      const token = new URLSearchParams(body ?? "").get("token");
      if (token) {
        const credential =
          credentialsByRefresh.get(token) ?? credentialsByAccess.get(token);
        if (credential) credential.active = false;
      }
      return new Response(null, { status: 204 });
    }

    const fixture = fixtures.get(`${request.method} ${url.pathname}`);
    if (!fixture) {
      return json(
        { error: { code: "not_found", message: "fixture not found" } },
        404,
      );
    }
    if (fixture.requiresAccessToken) {
      const token = bearerToken(request.headers.get("authorization"));
      const credential = token ? credentialsByAccess.get(token) : undefined;
      if (credential === undefined) {
        return json({ error: { code: "invalid_token" } }, 401, {
          "www-authenticate": 'Bearer error="invalid_token"',
        });
      }
      if (!credential.active || credential.expiresAt <= now()) {
        return json({ error: { code: "invalid_token" } }, 401, {
          "www-authenticate": 'Bearer error="invalid_token"',
        });
      }
      if (fixture.requiresOrganization) {
        const organizationId = request.headers.get("x-organization-id");
        if (
          !organizationId ||
          organizationId !== credential.organizationId ||
          (fixture.expectedOrganizationId &&
            organizationId !== fixture.expectedOrganizationId)
        ) {
          return json({ error: { code: "tenant_denied" } }, 403);
        }
      }
    }
    const response = fixture.response;
    if (response.rawBody !== undefined) {
      return new Response(response.rawBody, {
        status: response.status,
        headers: response.headers,
      });
    }
    return json(response.body, response.status, response.headers);
  });

  const url = `http://${server.hostname}:${server.port}`;
  return {
    url,
    oauthAuthorizeUrl: `${url}/oauth/authorize`,
    oauthTokenUrl: `${url}/oauth/token`,
    requests,
    receipts,
    createConnectionId() {
      return opaque("conn", seed, ++sequence);
    },
    enqueueFault(method, path, fault) {
      const key = `${method.toUpperCase()} ${path}`;
      faults.set(key, [...(faults.get(key) ?? []), fault]);
    },
    expireAccessToken(accessToken) {
      const credential = credentialsByAccess.get(accessToken);
      if (credential) credential.expiresAt = now() - 1;
    },
    revokeRefreshToken(refreshToken) {
      const credential = credentialsByRefresh.get(refreshToken);
      if (credential) credential.active = false;
    },
    async deliverWebhooks(targetUrl, events, secret) {
      const responses: Response[] = [];
      for (const event of events) {
        const payload = JSON.stringify(event);
        const timestamp = String(Math.floor(now() / 1000));
        const signature = createHmac("sha256", secret)
          .update(`${timestamp}.${payload}`)
          .digest("hex");
        responses.push(
          await fetch(targetUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-provider-event-id": event.id,
              "x-provider-timestamp": timestamp,
              "x-provider-signature": `v1=${signature}`,
            },
            body: payload,
          }),
        );
      }
      return responses;
    },
    recordAction(action, effect, allowed) {
      const receipt: ProviderActionReceipt = {
        id: opaque("receipt", seed, ++sequence),
        action,
        effect,
        outcome: allowed ? "succeeded" : "denied",
        createdAt: new Date(now()).toISOString(),
      };
      receipts.push(receipt);
      return receipt;
    },
    resetConnections: server.stop,
    stop: server.stop,
  };
}

export function redactProviderDiagnostics(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  const secretSet = new Set(secrets.filter(Boolean));
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === "string") {
      let redacted = redactSensitiveAssignments(candidate).replace(
        /Bearer\s+[^\s,;]+/gi,
        "Bearer <redacted>",
      );
      for (const secret of secretSet) {
        redacted = redacted.split(secret).join("<redacted>");
      }
      return redacted;
    }
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate).map(([key, item]) => [
          key,
          isSensitiveKey(key) ? "<redacted>" : visit(item),
        ]),
      );
    }
    return candidate;
  };
  return visit(value);
}

function issueCredential(
  organizationId: string,
  seed: string,
  sequence: number,
  expiresAt: number,
): Credential {
  return {
    accessToken: opaque("access", seed, sequence),
    refreshToken: opaque("refresh", seed, sequence),
    organizationId,
    expiresAt,
    active: true,
  };
}

function opaque(prefix: string, seed: string, sequence: number): string {
  return `${prefix}_${createHash("sha256")
    .update(`${seed}:${prefix}:${sequence}`)
    .digest("base64url")}`;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function tokenResponse(
  credential: Credential,
  tokenLifetimeMs: number,
): Response {
  return json({
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    token_type: "Bearer",
    expires_in: Math.floor(tokenLifetimeMs / 1000),
  });
}

function oauthError(error: string, status: number): Response {
  return json({ error }, status, { "cache-control": "no-store" });
}

function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

async function applyFault(fault: ProviderProtocolFault): Promise<Response> {
  if (fault.type === "delay") {
    await new Promise((resolve) => setTimeout(resolve, fault.durationMs));
    return json({ ok: true });
  }
  if (fault.type === "malformed-json") {
    return new Response(fault.body ?? "{not-json", {
      headers: { "content-type": "application/json" },
    });
  }
  if (fault.type === "schema-drift") return json(fault.body);
  if (fault.type === "status") {
    return json(fault.body, fault.status, fault.headers);
  }
  const exhaustive: never = fault;
  throw new Error(`Unknown provider fault: ${JSON.stringify(exhaustive)}`);
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function redactHeaders(headers: Headers): Record<string, string> {
  return redactEntries(headers);
}

function redactText(value: string | null): string | null {
  if (!value) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return JSON.stringify(redactProviderDiagnostics(parsed));
  } catch {
    // error-policy:J3 Non-JSON request bodies continue through explicit
    // form/header patterns; they are never interpreted as safe structured data.
  }
  const form = new URLSearchParams(value);
  if ([...form.keys()].some(isSensitiveKey)) {
    return new URLSearchParams(
      [...form.entries()].map(([key, item]): [string, string] => [
        key,
        isSensitiveKey(key) ? "<redacted>" : item,
      ]),
    ).toString();
  }
  return redactSensitiveAssignments(value).replace(
    /Bearer\s+[^\s,;]+/gi,
    "Bearer <redacted>",
  );
}

const SENSITIVE_KEY_SUFFIXES = [
  "authorization",
  "authorizationcode",
  "codeverifier",
  "cookie",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
  "apikey",
] as const;

const SENSITIVE_KEYS = new Set(["code", ...SENSITIVE_KEY_SUFFIXES]);

function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function redactEntries(
  entries: Iterable<readonly [string, string]>,
): Record<string, string> {
  return Object.fromEntries(
    [...entries].map(([key, value]) => [
      key,
      isSensitiveKey(key) ? "<redacted>" : value,
    ]),
  );
}

function redactSensitiveAssignments(value: string): string {
  return value.replace(
    /(^|[?&;,\s{])(["']?)([A-Za-z][A-Za-z0-9_.-]*)\2(\s*[:=]\s*)(?:(["'])(.*?)\5|([^&;,\s}]+))/g,
    (
      match,
      prefix,
      keyQuote,
      key,
      separator,
      valueQuote,
      _quotedValue,
      _unquotedValue,
    ) => {
      if (!isSensitiveKey(key)) return match;
      const quote = valueQuote ?? "";
      return `${prefix}${keyQuote}${key}${keyQuote}${separator}${quote}<redacted>${quote}`;
    },
  );
}
