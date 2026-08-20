/** Hosts a protocol-faithful OAuth, HTTP, and webhook provider for adapter tests. */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { payloadHash, type SyntheticWorld } from "@elizaos/synthetic-world";
import { startFetchServer } from "../fetch-server.js";
import {
  assertProviderProtocolFixtures,
  createProviderMockControl,
  PROVIDER_MOCK_CONTROL_PREFIX,
  ProviderMockControlClient,
  providerMockCoordinatorFor,
} from "./control.js";
import type {
  FakeProviderAccount,
  FakeProviderOAuthClient,
  ProviderActionReceipt,
  ProviderExecutedEffect,
  ProviderProtocolFault,
  ProviderProtocolFixture,
  RecordedProviderRequest,
} from "./types.js";

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  accountId: string;
  tenantId: string;
  connectionId: string;
  capabilities: readonly string[];
  used: boolean;
}

interface Credential {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  tenantId: string;
  connectionId: string;
  capabilities: readonly string[];
  expiresAt: number;
  active: boolean;
}

interface ActionPrincipal {
  accountId: string;
  tenantId: string;
  connectionId: string;
  capabilities: readonly string[];
}

interface CompletedAction {
  identityDigest: string;
  receipt: ProviderActionReceipt;
}

export interface FakeProviderOptions {
  providerId?: string;
  world?: SyntheticWorld;
  fixtures?: readonly ProviderProtocolFixture[];
  clientId?: string;
  accounts?: readonly FakeProviderAccount[];
  oauthClients?: readonly FakeProviderOAuthClient[];
  now?: () => number;
  tokenLifetimeMs?: number;
  seed?: string;
}

export interface FakeWebhookEvent {
  id: string;
  sequence: number;
  type: string;
  tenantId: string;
  accountId: string;
  connectionId: string;
  data: unknown;
}

export interface RunningFakeProvider {
  url: string;
  oauthAuthorizeUrl: string;
  oauthTokenUrl: string;
  controlUrl: string;
  control: ProviderMockControlClient;
  requests: RecordedProviderRequest[];
  readonly receipts: readonly ProviderActionReceipt[];
  readonly effects: readonly ProviderExecutedEffect[];
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
  /** Abruptly closes the upstream so the real adapter observes a network fault. */
  resetConnections(): Promise<void>;
  stop(): Promise<void>;
}

export async function startFakeProvider(
  options: FakeProviderOptions = {},
): Promise<RunningFakeProvider> {
  const initialFixtures = [...(options.fixtures ?? [])];
  assertProviderProtocolFixtures(initialFixtures, { allowEmpty: true });
  const fixtures = new Map(
    initialFixtures.map((fixture) => [
      `${fixture.method} ${fixture.path}`,
      fixture,
    ]),
  );
  const clientId = options.clientId ?? "contract-client";
  if (options.world && options.now) {
    throw new Error(
      "fake provider accepts either a synthetic world or now(), not both",
    );
  }
  const now = options.world
    ? () => options.world?.clock.now().getTime() ?? 0
    : (options.now ?? Date.now);
  const providerId = options.providerId ?? "generic-provider-contract";
  const tokenLifetimeMs = options.tokenLifetimeMs ?? 3_600_000;
  const seed = options.seed ?? "eliza-provider-contract-v1";
  const authorizationCodes = new Map<string, AuthorizationCode>();
  const credentialsByAccess = new Map<string, Credential>();
  const credentialsByRefresh = new Map<string, Credential>();
  const faults = new Map<string, ProviderProtocolFault[]>();
  const requests: RecordedProviderRequest[] = [];
  const receipts: ProviderActionReceipt[] = [];
  const effects: ProviderExecutedEffect[] = [];
  const completedActions = new Map<string, CompletedAction>();
  let sequence = 0;
  const accountSeeds =
    options.accounts ??
    ([
      {
        accountId: "acct-contract",
        tenantId: "org-1",
        capabilities: ["provider.read", "provider.write", "provider.delete"],
      },
    ] satisfies readonly FakeProviderAccount[]);
  const accounts = new Map(
    accountSeeds.map((account) => [account.accountId, account]),
  );
  if (accounts.size !== accountSeeds.length) {
    throw new Error("fake provider account IDs must be unique");
  }
  const oauthClients = new Map(
    (
      options.oauthClients ?? [
        {
          clientId,
          clientType: "public" as const,
          redirectUris: ["https://adapter.test/callback"],
          accountIds: accountSeeds[0] ? [accountSeeds[0].accountId] : [],
        },
      ]
    ).map((client) => [client.clientId, client]),
  );
  const configuredOAuthClients = [...oauthClients.values()];
  if (configuredOAuthClients.length !== (options.oauthClients?.length ?? 1)) {
    throw new Error("fake provider OAuth client IDs must be unique");
  }
  for (const registration of configuredOAuthClients) {
    if (
      registration.redirectUris.length === 0 ||
      registration.accountIds.length === 0 ||
      registration.accountIds.some((accountId) => !accounts.has(accountId)) ||
      (registration.clientType === "confidential" &&
        registration.clientSecret.length === 0)
    ) {
      throw new Error(
        `fake provider OAuth client ${registration.clientId} has an invalid provider-owned grant`,
      );
    }
  }
  const apiCredentials = new Map<string, ActionPrincipal>();
  const restoreInitialState = (): void => {
    fixtures.clear();
    for (const fixture of initialFixtures) {
      fixtures.set(`${fixture.method} ${fixture.path}`, fixture);
    }
    authorizationCodes.clear();
    credentialsByAccess.clear();
    credentialsByRefresh.clear();
    faults.clear();
    requests.length = 0;
    receipts.length = 0;
    effects.length = 0;
    completedActions.clear();
    apiCredentials.clear();
    sequence = 0;
    for (const account of accountSeeds) {
      if (!account.apiCredential) continue;
      if (apiCredentials.has(account.apiCredential)) {
        throw new Error("fake provider API credentials must be unique");
      }
      apiCredentials.set(account.apiCredential, {
        accountId: account.accountId,
        tenantId: account.tenantId,
        connectionId: opaque("conn", seed, ++sequence),
        capabilities: account.capabilities,
      });
    }
  };
  restoreInitialState();

  const enqueueFault = (
    method: string,
    path: string,
    fault: ProviderProtocolFault,
  ): void => {
    const key = `${method.toUpperCase()} ${path}`;
    faults.set(key, [...(faults.get(key) ?? []), fault]);
  };
  const controlToken = `control_${randomBytes(32).toString("base64url")}`;
  const controlHandler = createProviderMockControl({
    providerId,
    token: controlToken,
    now,
    coordinator: options.world
      ? providerMockCoordinatorFor(options.world)
      : undefined,
    adapter: {
      inspect: () => ({
        fixtureIds: [...fixtures.values()].map((fixture) => fixture.id).sort(),
        pendingFaults: [...faults.entries()]
          .map(([target, queue]) => ({ target, count: queue.length }))
          .sort((left, right) => left.target.localeCompare(right.target)),
        credentials: {
          authorizationCodes: authorizationCodes.size,
          accessTokens: credentialsByAccess.size,
          refreshTokens: credentialsByRefresh.size,
        },
        ledger: {
          requests: structuredClone(requests),
          receipts: structuredClone(receipts),
          effects: structuredClone(effects),
        },
      }),
      executionState: () => ({
        fixtureIds: [...fixtures.values()].map((fixture) => fixture.id).sort(),
        pendingFaults: [...faults.entries()]
          .map(([target, queue]) => ({
            target,
            faults: structuredClone(queue),
          }))
          .sort((left, right) => left.target.localeCompare(right.target)),
        credentials: {
          authorizationCodes: authorizationCodes.size,
          accessTokens: credentialsByAccess.size,
          refreshTokens: credentialsByRefresh.size,
        },
        completedActionCount: completedActions.size,
      }),
      reset: restoreInitialState,
      seed: (nextFixtures) => {
        for (const fixture of nextFixtures) {
          fixtures.set(`${fixture.method} ${fixture.path}`, fixture);
        }
      },
      enqueueFault,
    },
  });

  const server = await startFetchServer(async (request) => {
    const controlResponse = await controlHandler.handle(request);
    if (controlResponse) return controlResponse;
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
    const observation = {
      method: request.method,
      path: url.pathname,
      query: redactEntries(url.searchParams),
    };
    options.world?.ledger.append({
      kind: "request",
      status: "observed",
      target: `provider.${providerId}.http`,
      input: observation,
      payloadHash: payloadHash(observation),
      idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
      attempt: requests.length,
    });

    const faultKey = `${request.method} ${url.pathname}`;
    const queued = faults.get(faultKey);
    const fault = queued?.shift();
    if (fault) return applyFault(fault, options.world);

    if (url.pathname === "/oauth/authorize" && request.method === "GET") {
      const responseType = url.searchParams.get("response_type");
      const requestedClientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      const challengeMethod = url.searchParams.get("code_challenge_method");
      const registration = requestedClientId
        ? oauthClients.get(requestedClientId)
        : undefined;
      const requestedAccountId = registration?.accountIds[0];
      const account = requestedAccountId
        ? accounts.get(requestedAccountId)
        : undefined;
      if (
        responseType !== "code" ||
        !registration ||
        !redirectUri ||
        !registration.redirectUris.includes(redirectUri) ||
        url.searchParams.has("account_id") ||
        url.searchParams.has("organization_id") ||
        !account ||
        !registration.accountIds.includes(account.accountId) ||
        !state ||
        !challenge ||
        challengeMethod !== "S256"
      ) {
        return oauthError("invalid_request", 400);
      }
      const code = opaque("code", seed, ++sequence);
      authorizationCodes.set(code, {
        clientId: registration.clientId,
        redirectUri,
        challenge,
        accountId: account.accountId,
        tenantId: account.tenantId,
        connectionId: opaque("conn", seed, ++sequence),
        capabilities: account.capabilities,
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
          pkceChallenge(verifier) !== entry.challenge ||
          !oauthClientAuthenticated(oauthClients.get(entry.clientId), form)
        ) {
          return oauthError("invalid_grant", 400);
        }
        entry.used = true;
        const credential = issueCredential(
          entry,
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
        if (
          !prior.active ||
          prior.expiresAt <= now() ||
          form.get("client_id") !== prior.clientId ||
          !oauthClientAuthenticated(oauthClients.get(prior.clientId), form)
        ) {
          return oauthError("invalid_grant", 400);
        }
        prior.active = false;
        const credential = issueCredential(
          prior,
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
          organizationId !== credential.tenantId ||
          (fixture.expectedOrganizationId &&
            organizationId !== fixture.expectedOrganizationId)
        ) {
          return json({ error: { code: "tenant_denied" } }, 403);
        }
      }
    }
    if (fixture.action) {
      return handleProviderAction({
        request,
        body,
        fixture,
        principal: resolvePrincipal(
          request,
          credentialsByAccess,
          apiCredentials,
          now(),
        ),
        now,
        seed,
        nextSequence: () => ++sequence,
        receipts,
        effects,
        completedActions,
      });
    }
    return fixtureResponse(fixture);
  });

  const url = `http://${server.hostname}:${server.port}`;
  const controlUrl = `${url}${PROVIDER_MOCK_CONTROL_PREFIX}`;
  const stop = async (): Promise<void> => {
    controlHandler.dispose();
    await server.stop();
  };
  return {
    url,
    oauthAuthorizeUrl: `${url}/oauth/authorize`,
    oauthTokenUrl: `${url}/oauth/token`,
    controlUrl,
    control: new ProviderMockControlClient(controlUrl, controlToken),
    requests,
    get receipts() {
      return receipts.map((receipt) => structuredClone(receipt));
    },
    get effects() {
      return effects.map((effect) => structuredClone(effect));
    },
    createConnectionId() {
      return opaque("conn", seed, ++sequence);
    },
    enqueueFault(method, path, fault) {
      enqueueFault(method, path, fault);
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
    resetConnections: stop,
    stop,
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

function resolvePrincipal(
  request: Request,
  credentialsByAccess: ReadonlyMap<string, Credential>,
  apiCredentials: ReadonlyMap<string, ActionPrincipal>,
  currentTime: number,
): ActionPrincipal | null {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return null;
  const credential = credentialsByAccess.get(token);
  if (credential?.active && credential.expiresAt > currentTime) {
    return credential;
  }
  return apiCredentials.get(token) ?? null;
}

interface ProviderActionContext {
  request: Request;
  body: string | null;
  fixture: ProviderProtocolFixture;
  principal: ActionPrincipal | null;
  now: () => number;
  seed: string;
  nextSequence: () => number;
  receipts: ProviderActionReceipt[];
  effects: ProviderExecutedEffect[];
  completedActions: Map<string, CompletedAction>;
}

function handleProviderAction(context: ProviderActionContext): Response {
  const { fixture, principal, request } = context;
  const policy = fixture.action;
  if (!policy) return fixtureResponse(fixture);
  if (!principal) {
    return json({ error: { code: "invalid_token" } }, 401, {
      "www-authenticate": 'Bearer error="invalid_token"',
    });
  }

  const requestId =
    request.headers.get("x-provider-request-id") ??
    opaque("request", context.seed, context.nextSequence());
  const idempotencyKey = request.headers.get("idempotency-key");
  const identityDigest = createHash("sha256")
    .update(
      `${request.method}:${new URL(request.url).pathname}:${context.body ?? ""}`,
    )
    .digest("hex");
  const tenantHeader = request.headers.get("x-organization-id");
  const accountHeader = request.headers.get("x-provider-account-id");
  const confirmationHeader = request.headers.get("x-provider-confirmation-id");
  const confirmation =
    policy.confirmation.state === "required"
      ? confirmationHeader === policy.confirmation.confirmationId
        ? "confirmed"
        : "missing"
      : policy.confirmation.state;
  const denialReason =
    tenantHeader && tenantHeader !== principal.tenantId
      ? "cross_tenant"
      : accountHeader && accountHeader !== principal.accountId
        ? "cross_account"
        : !principal.capabilities.includes(policy.capabilityId)
          ? "capability_not_granted"
          : policy.decision === "deny"
            ? "policy_denied"
            : confirmation === "missing"
              ? "confirmation_required"
              : null;
  if (denialReason) {
    const receipt = deniedActionReceipt(context, {
      principal,
      requestId,
      idempotencyKey,
      confirmation,
      reasonCode: denialReason,
      statusCode: denialReason === "confirmation_required" ? 409 : 403,
    });
    context.receipts.push(receipt);
    return json(
      { error: { code: denialReason }, receipt_id: receipt.id },
      receipt.providerResult.statusCode,
      { "x-provider-receipt-id": receipt.id },
    );
  }

  const replayKey = idempotencyKey
    ? `${principal.accountId}:${principal.connectionId}:${policy.capabilityId}:${idempotencyKey}`
    : null;
  const completed = replayKey
    ? context.completedActions.get(replayKey)
    : undefined;
  if (completed) {
    if (completed.identityDigest !== identityDigest) {
      const receipt = deniedActionReceipt(context, {
        principal,
        requestId,
        idempotencyKey,
        confirmation,
        reasonCode: "idempotency_conflict",
        statusCode: 409,
      });
      context.receipts.push(receipt);
      return json(
        { error: { code: "idempotency_conflict" }, receipt_id: receipt.id },
        409,
        { "x-provider-receipt-id": receipt.id },
      );
    }
    const receiptId = opaque("receipt", context.seed, context.nextSequence());
    const policyDecisionId = opaque(
      "decision",
      context.seed,
      context.nextSequence(),
    );
    const receipt: ProviderActionReceipt = {
      ...completed.receipt,
      id: receiptId,
      outcome: "replayed",
      request: {
        id: requestId,
        idempotencyKey,
        replayOfReceiptId: completed.receipt.id,
      },
      policy: {
        ...completed.receipt.policy,
        decisionId: policyDecisionId,
      },
      policyDecisionId,
      executedEffect: { performed: false, effectId: null },
      effect: {
        receiptId,
        operation: policy.operation,
        resource: {
          kind: policy.capabilityId,
          id: completed.receipt.providerResult.resultId ?? requestId,
        },
        artifacts: [],
        idempotency: { key: idempotencyKey, replayed: true },
        observedAt: new Date(context.now()).toISOString(),
        outcome: "noop",
        reason: "provider idempotency contract replayed the accepted result",
      },
      createdAt: new Date(context.now()).toISOString(),
    };
    context.receipts.push(receipt);
    return fixtureResponse(fixture, { "x-provider-receipt-id": receipt.id });
  }

  const response = fixture.response;
  const resultRepresentation =
    response.rawBody ?? JSON.stringify(response.body ?? null);
  const resultId =
    providerResultId(response.body) ??
    opaque("result", context.seed, context.nextSequence());
  const providerAccepted = response.status >= 200 && response.status < 300;
  const effectId = providerAccepted
    ? opaque("effect", context.seed, context.nextSequence())
    : null;
  const receiptId = opaque("receipt", context.seed, context.nextSequence());
  const policyDecisionId = opaque(
    "decision",
    context.seed,
    context.nextSequence(),
  );
  const observedAt = new Date(context.now()).toISOString();
  const receipt: ProviderActionReceipt = {
    id: receiptId,
    tenantId: principal.tenantId,
    accountId: principal.accountId,
    connectionId: principal.connectionId,
    capabilityId: policy.capabilityId,
    operation: policy.operation,
    effectKind: policy.effect,
    outcome: providerAccepted ? "succeeded" : "failed",
    request: { id: requestId, idempotencyKey, replayOfReceiptId: null },
    policy: {
      decisionId: policyDecisionId,
      riskLevel: policy.riskLevel,
      outcome: "allowed",
      confirmation,
      confirmationId:
        policy.confirmation.state === "required"
          ? policy.confirmation.confirmationId
          : null,
      reasonCode: null,
    },
    policyDecisionId,
    providerResult: {
      status: providerAccepted ? "accepted" : "rejected",
      statusCode: response.status,
      resultId: providerAccepted ? resultId : null,
      digest: createHash("sha256")
        .update(`${response.status}:${resultRepresentation}`)
        .digest("hex"),
    },
    executedEffect: { performed: providerAccepted, effectId },
    effect: providerAccepted
      ? {
          receiptId,
          operation: policy.operation,
          resource: { kind: policy.capabilityId, id: resultId },
          artifacts: [],
          idempotency: { key: idempotencyKey, replayed: false },
          observedAt,
          outcome: "applied",
          commit: {
            kind: "provider_accepted",
            id: resultId,
            committedAt: observedAt,
          },
        }
      : {
          receiptId,
          operation: policy.operation,
          resource: { kind: policy.capabilityId, id: requestId },
          artifacts: [],
          idempotency: { key: idempotencyKey, replayed: false },
          observedAt,
          outcome: "failed",
          failure: {
            code: `provider_http_${response.status}`,
            retryable: response.status >= 500,
            acceptance: "rejected",
          },
        },
    createdAt: observedAt,
  };
  if (providerAccepted && effectId) {
    context.effects.push({
      id: effectId,
      tenantId: principal.tenantId,
      accountId: principal.accountId,
      connectionId: principal.connectionId,
      capabilityId: policy.capabilityId,
      operation: policy.operation,
      requestId,
      idempotencyKey,
      providerResultId: resultId,
      performedAt: receipt.createdAt,
    });
  }
  context.receipts.push(receipt);
  if (replayKey && providerAccepted) {
    context.completedActions.set(replayKey, { identityDigest, receipt });
  }
  return fixtureResponse(fixture, { "x-provider-receipt-id": receipt.id });
}

function deniedActionReceipt(
  context: ProviderActionContext,
  input: {
    principal: ActionPrincipal;
    requestId: string;
    idempotencyKey: string | null;
    confirmation: "not_required" | "already_granted" | "confirmed" | "missing";
    reasonCode: string;
    statusCode: number;
  },
): ProviderActionReceipt {
  const policy = context.fixture.action;
  if (!policy) throw new Error("provider action receipt requires policy");
  const receiptId = opaque("receipt", context.seed, context.nextSequence());
  const policyDecisionId = opaque(
    "decision",
    context.seed,
    context.nextSequence(),
  );
  const observedAt = new Date(context.now()).toISOString();
  return {
    id: receiptId,
    tenantId: input.principal.tenantId,
    accountId: input.principal.accountId,
    connectionId: input.principal.connectionId,
    capabilityId: policy.capabilityId,
    operation: policy.operation,
    effectKind: policy.effect,
    outcome: "denied",
    request: {
      id: input.requestId,
      idempotencyKey: input.idempotencyKey,
      replayOfReceiptId: null,
    },
    policy: {
      decisionId: policyDecisionId,
      riskLevel: policy.riskLevel,
      outcome: "denied",
      confirmation: input.confirmation,
      confirmationId:
        policy.confirmation.state === "required"
          ? policy.confirmation.confirmationId
          : null,
      reasonCode: input.reasonCode,
    },
    policyDecisionId,
    providerResult: {
      status: "not_sent",
      statusCode: input.statusCode,
      resultId: null,
      digest: null,
    },
    executedEffect: { performed: false, effectId: null },
    effect: {
      receiptId,
      operation: policy.operation,
      resource: { kind: policy.capabilityId, id: input.requestId },
      artifacts: [],
      idempotency: {
        key: input.idempotencyKey,
        replayed: false,
      },
      observedAt,
      outcome: "failed",
      failure: {
        code: input.reasonCode,
        retryable: false,
        acceptance: "rejected",
      },
    },
    createdAt: observedAt,
  };
}

function providerResultId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.id === "string" || typeof record.id === "number") {
    return String(record.id);
  }
  if (record.server && typeof record.server === "object") {
    const serverId = (record.server as Record<string, unknown>).id;
    if (typeof serverId === "string" || typeof serverId === "number") {
      return String(serverId);
    }
  }
  return null;
}

function fixtureResponse(
  fixture: ProviderProtocolFixture,
  extraHeaders: Record<string, string> = {},
): Response {
  const response = fixture.response;
  if (response.rawBody !== undefined) {
    return new Response(response.rawBody, {
      status: response.status,
      headers: { ...response.headers, ...extraHeaders },
    });
  }
  return json(response.body, response.status, {
    ...response.headers,
    ...extraHeaders,
  });
}

function issueCredential(
  principal: ActionPrincipal & { clientId: string },
  seed: string,
  sequence: number,
  expiresAt: number,
): Credential {
  return {
    accessToken: opaque("access", seed, sequence),
    refreshToken: opaque("refresh", seed, sequence),
    clientId: principal.clientId,
    accountId: principal.accountId,
    tenantId: principal.tenantId,
    connectionId: principal.connectionId,
    capabilities: principal.capabilities,
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

function oauthClientAuthenticated(
  registration: FakeProviderOAuthClient | undefined,
  form: URLSearchParams,
): boolean {
  if (!registration) return false;
  if (registration.clientType === "public") return true;
  return form.get("client_secret") === registration.clientSecret;
}

async function applyFault(
  fault: ProviderProtocolFault,
  world?: SyntheticWorld,
): Promise<Response> {
  if (fault.type === "delay") {
    if (world) await world.clock.advanceBy(fault.durationMs);
    else await new Promise((resolve) => setTimeout(resolve, fault.durationMs));
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
