/**
 * Promotes the production GitHub ConnectorAccountManager OAuth implementation
 * against the loopback provider, including state consumption and PKCE-bound
 * callback exchange. Unsupported lifecycle operations are reported explicitly.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  getConnectorAccountManager,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";
import {
  createGitHubConnectorAccountProviderForTest,
  GitHubOAuthHttpError,
} from "@elizaos/plugin-github";
import {
  type ProviderContractObservation,
  type ProviderContractScenario,
  type RunningFakeProvider,
  runProviderAdapterConformance,
  startFakeProvider,
} from "../../src/provider-contract";

const REDIRECT_URI = "https://adapter.test/callback";
const CLIENT_ID = "contract-client";
const CLIENT_SECRET = "github-contract-secret";

let upstream: RunningFakeProvider;

beforeAll(async () => {
  upstream = await startFakeProvider({
    oauthClients: [
      {
        clientId: CLIENT_ID,
        clientType: "confidential",
        clientSecret: CLIENT_SECRET,
        redirectUris: [REDIRECT_URI],
        accountIds: ["acct-contract"],
      },
    ],
    fixtures: [
      {
        id: "github-user",
        method: "GET",
        path: "/github/user",
        requiresAccessToken: true,
        response: {
          status: 200,
          body: {
            id: 42,
            login: "contract-user",
            name: "Contract User",
            type: "User",
          },
        },
      },
    ],
  });
});

afterAll(async () => {
  await upstream.stop();
});

function passed(
  scenario: ProviderContractScenario,
  detail: string,
  extra: Partial<ProviderContractObservation> = {},
): ProviderContractObservation {
  return { scenario, status: "passed", detail, ...extra };
}

function createRuntime(): IAgentRuntime {
  const vault = new Map<string, string>();
  return {
    agentId: "00000000-0000-0000-0000-000000000042" as UUID,
    getSetting(key: string) {
      return (
        {
          GITHUB_OAUTH_CLIENT_ID: CLIENT_ID,
          GITHUB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
          GITHUB_OAUTH_REDIRECT_URI: REDIRECT_URI,
        } as Record<string, string>
      )[key];
    },
    getService(serviceType: string) {
      if (serviceType === "vault" || serviceType === "VAULT") {
        return {
          set: async (key: string, value: string) => {
            vault.set(key, value);
          },
        };
      }
      return null;
    },
    adapter: {
      setConnectorAccountCredentialRef: async () => undefined,
    },
  } as never as IAgentRuntime;
}

function createManager(requestTimeoutMs = 1_000) {
  const runtime = createRuntime();
  const manager = getConnectorAccountManager(runtime);
  const adapter = createGitHubConnectorAccountProviderForTest(runtime, {
    authorizationEndpoint: upstream.oauthAuthorizeUrl,
    tokenEndpoint: upstream.oauthTokenUrl,
    userEndpoint: `${upstream.url}/github/user`,
    requestTimeoutMs,
  });
  manager.registerProvider(adapter);
  return { adapter, manager };
}

async function authorize(manager: ReturnType<typeof createManager>["manager"]) {
  const flow = await manager.startOAuth("github");
  expect(flow.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const authUrl = new URL(flow.authUrl ?? "");
  expect(authUrl.searchParams.get("state")).toBe(flow.state);
  expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
  const response = await fetch(authUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  const callback = new URL(response.headers.get("location") ?? "");
  return { callback, flow };
}

async function completeFreshOAuth() {
  const { manager } = createManager();
  const { callback, flow } = await authorize(manager);
  const result = await manager.completeOAuth("github", {
    state: callback.searchParams.get("state") ?? "",
    code: callback.searchParams.get("code") ?? "",
    query: Object.fromEntries(callback.searchParams),
  });
  expect(result.flow.status).toBe("completed");
  expect(result.account).toMatchObject({
    provider: "github",
    displayHandle: "contract-user",
    status: "connected",
  });
  return { flow, manager, result };
}

async function expectTokenFault(
  fault: Parameters<RunningFakeProvider["enqueueFault"]>[2],
  expected: RegExp,
): Promise<unknown> {
  const { manager } = createManager();
  const { callback } = await authorize(manager);
  upstream.enqueueFault("POST", "/oauth/token", fault);
  let captured: unknown;
  try {
    await manager.completeOAuth("github", {
      state: callback.searchParams.get("state") ?? "",
      code: callback.searchParams.get("code") ?? "",
      query: Object.fromEntries(callback.searchParams),
    });
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(Error);
  const messages: string[] = [];
  let current: unknown = captured;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join("\n")).toMatch(expected);
  return captured;
}

describe("GitHub connector OAuth production contract", () => {
  test("executes the real OAuth provider and callback parser", async () => {
    const report = await runProviderAdapterConformance({
      adapterName: "GitHubConnectorAccountProvider",
      profile: "outbound-http",
      capabilities: ["oauth"],
      scenarios: {
        success: async () => {
          await completeFreshOAuth();
          const tokenRequest = upstream.requests.findLast(
            (request) => request.path === "/oauth/token",
          );
          expect(tokenRequest?.body).toContain("client_secret=%3Credacted%3E");
          expect(tokenRequest?.body).not.toContain(CLIENT_SECRET);
          return passed(
            "success",
            "production connector completed a PKCE-bound loopback grant",
          );
        },
        "designed-empty": async () => {
          const { manager } = createManager();
          expect(await manager.listAccounts("github")).toEqual([]);
          return passed(
            "designed-empty",
            "production provider returns an explicit empty account list",
          );
        },
        "invalid-input": async () => {
          const { adapter, manager } = createManager();
          await expect(
            adapter.completeOAuth?.(
              {
                provider: "github",
                query: {},
                flow: {
                  id: "oauth_invalid",
                  provider: "github",
                  state: "state_invalid",
                  status: "pending",
                  codeVerifier: "verifier",
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
              },
              manager,
            ),
          ).rejects.toThrow(/missing an authorization code/i);
          return passed(
            "invalid-input",
            "production callback rejects a missing authorization code",
          );
        },
        "rate-limit-retry-metadata": async () => {
          const error = await expectTokenFault(
            {
              type: "status",
              status: 429,
              headers: { "retry-after": "4" },
              body: { error: "rate_limited" },
            },
            /failed with 429/,
          );
          let current: unknown = error;
          let transportError: GitHubOAuthHttpError | undefined;
          while (current instanceof Error) {
            if (current instanceof GitHubOAuthHttpError) {
              transportError = current;
              break;
            }
            current = current.cause;
          }
          expect(transportError).toMatchObject({
            statusCode: 429,
            retryAfterSeconds: 4,
          });
          return passed(
            "rate-limit-retry-metadata",
            "production OAuth error retains exact Retry-After seconds",
          );
        },
        "malformed-json": async () => {
          await expectTokenFault({ type: "malformed-json" }, /JSON|parse/i);
          return passed(
            "malformed-json",
            "production token parser rejects malformed JSON",
          );
        },
        "schema-drift": async () => {
          await expectTokenFault(
            { type: "schema-drift", body: { token: "renamed" } },
            /no access_token/i,
          );
          return passed(
            "schema-drift",
            "production token parser fails closed when access_token is renamed",
          );
        },
        timeout: async () => {
          const { manager } = createManager(5);
          const { callback } = await authorize(manager);
          upstream.enqueueFault("POST", "/oauth/token", {
            type: "delay",
            durationMs: 100,
          });
          await expect(
            manager.completeOAuth("github", {
              state: callback.searchParams.get("state") ?? "",
              code: callback.searchParams.get("code") ?? "",
            }),
          ).rejects.toThrow();
          return passed(
            "timeout",
            "finite production request deadline aborted a delayed token exchange",
          );
        },
        "connection-reset": async () => {
          const reset = await startFakeProvider();
          const runtime = createRuntime();
          const manager = getConnectorAccountManager(runtime);
          manager.registerProvider(
            createGitHubConnectorAccountProviderForTest(runtime, {
              authorizationEndpoint: reset.oauthAuthorizeUrl,
              tokenEndpoint: reset.oauthTokenUrl,
              userEndpoint: `${reset.url}/github/user`,
              requestTimeoutMs: 1_000,
            }),
          );
          const { callback } = await authorize(manager);
          await reset.stop();
          await expect(
            manager.completeOAuth("github", {
              state: callback.searchParams.get("state") ?? "",
              code: callback.searchParams.get("code") ?? "",
            }),
          ).rejects.toThrow();
          return passed(
            "connection-reset",
            "production token exchange reports a stopped loopback upstream",
          );
        },
        "provider-4xx": async () => {
          await expectTokenFault(
            { type: "status", status: 403, body: { error: "denied" } },
            /failed with 403/,
          );
          return passed(
            "provider-4xx",
            "production token exchange preserves the provider 403 boundary",
          );
        },
        "provider-5xx": async () => {
          await expectTokenFault(
            { type: "status", status: 502, body: { error: "down" } },
            /failed with 502/,
          );
          return passed(
            "provider-5xx",
            "production token exchange preserves the provider 502 boundary",
          );
        },
        "opaque-connection-id": async () => {
          const { result } = await completeFreshOAuth();
          const connectionId = result.account?.id;
          expect(connectionId).toMatch(/^conn_[A-Za-z0-9_-]{16,}$/);
          return passed(
            "opaque-connection-id",
            "production connector account uses a stable opaque provider handle",
            { connectionId },
          );
        },
        "secret-redaction": async () => {
          const { flow } = await completeFreshOAuth();
          const serialized = JSON.stringify(upstream.requests);
          expect(serialized).not.toContain(CLIENT_SECRET);
          expect(serialized).not.toContain(
            flow.codeVerifier ?? "missing-verifier",
          );
          return passed(
            "secret-redaction",
            "loopback capture redacts production client secret and PKCE verifier",
            { diagnostic: upstream.requests.at(-1) },
          );
        },
        "read-policy": async () => {
          const { manager } = await completeFreshOAuth();
          expect(await manager.listAccounts("github")).toHaveLength(1);
          return passed(
            "read-policy",
            "production account manager lists only the connected GitHub account",
          );
        },
        "oauth-state-pkce": async () => {
          const { manager } = createManager();
          const { callback, flow } = await authorize(manager);
          await expect(
            manager.completeOAuth("github", {
              state: `${flow.state}-altered`,
              code: callback.searchParams.get("code") ?? "",
            }),
          ).rejects.toThrow(/unknown, expired, or already used/i);
          const result = await manager.completeOAuth("github", {
            state: callback.searchParams.get("state") ?? "",
            code: callback.searchParams.get("code") ?? "",
          });
          expect(result.flow.status).toBe("completed");
          return passed(
            "oauth-state-pkce",
            "real manager rejected altered state and exchanged the code with its one-time verifier",
          );
        },
      },
    });
    expect(report.observations.length).toBeGreaterThanOrEqual(14);
  }, 20_000);
});
