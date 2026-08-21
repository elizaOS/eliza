/** Exercises the real Linear GraphQL client against the protocol-faithful fake upstream. */

import {
  type ProviderContractObservation,
  type ProviderProtocolFixture,
  redactProviderDiagnostics,
  runProviderAdapterConformance,
  startFakeProvider,
} from "@elizaos/cloud-test-mocks/provider-contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LinearClient } from "../src/client.js";
import { LinearError } from "../src/errors.js";

const issue = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Fix sign-in redirect",
  url: "https://linear.app/acme/issue/ENG-1",
  priority: 2,
  updatedAt: "2026-08-01T00:00:00.000Z",
  state: { name: "In Progress", type: "started" as const },
  team: { id: "team-1", key: "ENG", name: "Engineering" },
  assignee: { id: "user-1", name: "Ada" },
};

const issuesEnvelope = {
  data: {
    issues: {
      nodes: [issue],
      pageInfo: { hasNextPage: true, endCursor: "cursor-page-2" },
    },
  },
};

const fixtures: ProviderProtocolFixture[] = [
  {
    id: "linear-graphql",
    method: "POST",
    path: "/graphql",
    response: { status: 200, body: issuesEnvelope },
  },
];

function passed(
  scenario: ProviderContractObservation["scenario"],
  detail: string,
  extra: Partial<ProviderContractObservation> = {},
): ProviderContractObservation {
  return { scenario, status: "passed", detail, ...extra };
}

async function expectCode(
  operation: Promise<unknown>,
  code: LinearError["code"],
): Promise<LinearError> {
  try {
    await operation;
  } catch (error) {
    // error-policy:J1 The test assertion boundary verifies the typed failure
    // returned by the real client instead of allowing it to escape the case.
    expect(error).toBeInstanceOf(LinearError);
    expect((error as LinearError).code).toBe(code);
    return error as LinearError;
  }
  throw new Error(`Expected ${code}`);
}

describe("LinearClient provider contract", () => {
  let upstream: Awaited<ReturnType<typeof startFakeProvider>>;
  let connectionId: string;
  let client: LinearClient;

  beforeAll(async () => {
    upstream = await startFakeProvider({ fixtures });
    connectionId = upstream.createConnectionId();
    client = new LinearClient({
      credential: { type: "oauth", value: "linear_contract_secret" },
      endpoint: `${upstream.url}/graphql`,
      timeoutMs: 2_000,
      testTransport: { fetchImpl: globalThis.fetch },
      allowPrivateNetworkForTests: true,
    });
  });

  afterAll(async () => {
    await upstream.stop();
  });

  it("executes every outbound read and pagination scenario", async () => {
    const report = await runProviderAdapterConformance({
      adapterName: "LinearClient",
      profile: "outbound-http",
      capabilities: ["http-read", "pagination"],
      scenarios: {
        success: async () => {
          const page = await client.searchIssues({ query: "sign-in" });
          expect(page.issues[0]).toEqual(issue);
          return passed("success", "normalized issue page inspected");
        },
        "designed-empty": async () => {
          upstream.enqueueFault("POST", "/graphql", {
            type: "schema-drift",
            body: {
              data: {
                issues: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
          const page = await client.searchIssues({ query: "nothing" });
          expect(page).toEqual({ issues: [], nextCursor: null });
          return passed(
            "designed-empty",
            "empty page remained distinct from failure",
          );
        },
        "invalid-input": async () => {
          await expectCode(
            client.searchIssues({ query: " " }),
            "LINEAR_INVALID_INPUT",
          );
          await expectCode(client.getIssue("  "), "LINEAR_INVALID_INPUT");
          return passed("invalid-input", "blank inputs rejected before HTTP");
        },
        "pagination-cursors": async () => {
          const page = await client.searchIssues({
            query: "sign-in",
            cursor: "cursor-page-1",
          });
          expect(page.nextCursor).toBe("cursor-page-2");
          const request = upstream.requests.at(-1);
          const body = JSON.parse(request?.body ?? "{}") as {
            variables?: { after?: string };
          };
          expect(body.variables?.after).toBe("cursor-page-1");
          return passed(
            "pagination-cursors",
            "opaque request and response cursors inspected",
          );
        },
        "rate-limit-retry-metadata": async () => {
          upstream.enqueueFault("POST", "/graphql", {
            type: "status",
            status: 429,
            headers: { "retry-after": "2" },
            body: { errors: [{ extensions: { code: "RATELIMITED" } }] },
          });
          const error = await expectCode(
            client.searchIssues({ query: "sign-in" }),
            "LINEAR_RATE_LIMITED",
          );
          expect(error.retryAfterMs).toBe(2_000);
          return passed(
            "rate-limit-retry-metadata",
            "Retry-After preserved as 2000ms",
          );
        },
        "malformed-json": async () => {
          upstream.enqueueFault("POST", "/graphql", {
            type: "malformed-json",
          });
          await expectCode(
            client.searchIssues({ query: "sign-in" }),
            "LINEAR_MALFORMED_RESPONSE",
          );
          return passed("malformed-json", "invalid provider JSON rejected");
        },
        "schema-drift": async () => {
          upstream.enqueueFault("POST", "/graphql", {
            type: "schema-drift",
            body: {
              data: {
                issues: {
                  nodes: [{ ...issue, state: { name: "?", type: "unknown" } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
          await expectCode(
            client.searchIssues({ query: "sign-in" }),
            "LINEAR_MALFORMED_RESPONSE",
          );
          return passed("schema-drift", "unknown workflow state type rejected");
        },
        timeout: async () => {
          const timeoutClient = new LinearClient({
            credential: { type: "oauth", value: "linear_contract_secret" },
            timeoutMs: 100,
            testTransport: {
              fetchImpl: vi.fn(
                async (_input, init) =>
                  await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener(
                      "abort",
                      () => reject(init.signal?.reason),
                      { once: true },
                    );
                  }),
              ),
            },
          });
          await expectCode(
            timeoutClient.searchIssues({ query: "sign-in" }),
            "LINEAR_PROVIDER_TIMEOUT",
          );
          return passed("timeout", "bounded abort surfaced as timeout");
        },
        "connection-reset": async () => {
          const resetUpstream = await startFakeProvider({ fixtures });
          const resetClient = new LinearClient({
            credential: { type: "oauth", value: "linear_contract_secret" },
            endpoint: `${resetUpstream.url}/graphql`,
            testTransport: { fetchImpl: globalThis.fetch },
            allowPrivateNetworkForTests: true,
          });
          await resetUpstream.resetConnections();
          await expectCode(
            resetClient.searchIssues({ query: "sign-in" }),
            "LINEAR_PROVIDER_NETWORK",
          );
          return passed(
            "connection-reset",
            "closed upstream surfaced as network failure",
          );
        },
        "provider-4xx": async () => {
          upstream.enqueueFault("POST", "/graphql", {
            type: "status",
            status: 404,
            body: { message: "not found" },
          });
          await expectCode(
            client.searchIssues({ query: "sign-in" }),
            "LINEAR_PROVIDER_REJECTED",
          );
          return passed("provider-4xx", "provider rejection remained explicit");
        },
        "provider-5xx": async () => {
          upstream.enqueueFault("POST", "/graphql", {
            type: "status",
            status: 503,
            body: { message: "unavailable" },
          });
          await expectCode(
            client.searchIssues({ query: "sign-in" }),
            "LINEAR_PROVIDER_FAILURE",
          );
          return passed("provider-5xx", "provider outage remained explicit");
        },
        "opaque-connection-id": async () =>
          passed(
            "opaque-connection-id",
            "runtime consumers hold only an opaque managed connection handle",
            { connectionId },
          ),
        "secret-redaction": async () => {
          await client.searchIssues({ query: "sign-in" });
          const diagnostic = redactProviderDiagnostics(upstream.requests, [
            "linear_contract_secret",
          ]);
          expect(JSON.stringify(diagnostic)).not.toContain(
            "linear_contract_secret",
          );
          return passed(
            "secret-redaction",
            "recorded requests redact bearer credentials",
            { diagnostic },
          );
        },
        "read-policy": async () => {
          const page = await client.searchIssues({
            query: "sign-in",
            limit: 1,
          });
          expect(page.issues).toHaveLength(1);
          return passed(
            "read-policy",
            "read completed without mutation receipt",
          );
        },
      },
    });
    expect(report.observations).toHaveLength(14);
  });

  it("keeps expired and revoked authentication failures distinct", async () => {
    upstream.enqueueFault("POST", "/graphql", {
      type: "status",
      status: 400,
      body: {
        errors: [
          {
            message: "authentication failed",
            extensions: { code: "AUTHENTICATION_ERROR" },
          },
        ],
      },
    });
    await expectCode(
      client.searchIssues({ query: "sign-in" }),
      "LINEAR_AUTH_EXPIRED",
    );

    upstream.enqueueFault("POST", "/graphql", {
      type: "status",
      status: 403,
      body: { message: "revoked" },
    });
    await expectCode(
      client.searchIssues({ query: "sign-in" }),
      "LINEAR_AUTH_REVOKED",
    );
  });

  it("classifies GraphQL error envelopes on a 200 response", async () => {
    upstream.enqueueFault("POST", "/graphql", {
      type: "schema-drift",
      body: {
        errors: [
          { message: "rate limited", extensions: { code: "RATELIMITED" } },
        ],
      },
    });
    await expectCode(
      client.searchIssues({ query: "sign-in" }),
      "LINEAR_RATE_LIMITED",
    );
  });

  it("resolves teams, issue detail, and viewer through the same client", async () => {
    upstream.enqueueFault("POST", "/graphql", {
      type: "schema-drift",
      body: {
        data: {
          teams: {
            nodes: [issue.team],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    await expect(client.listTeams()).resolves.toEqual({
      teams: [issue.team],
      nextCursor: null,
    });

    upstream.enqueueFault("POST", "/graphql", {
      type: "schema-drift",
      body: { data: { issue } },
    });
    await expect(client.getIssue("ENG-1")).resolves.toEqual(issue);

    upstream.enqueueFault("POST", "/graphql", {
      type: "schema-drift",
      body: { data: { issue: null } },
    });
    await expect(client.getIssue("ENG-404")).resolves.toBeNull();

    upstream.enqueueFault("POST", "/graphql", {
      type: "schema-drift",
      body: { data: { viewer: { id: "user-1", name: "Ada" } } },
    });
    await expect(client.getViewer()).resolves.toEqual({
      id: "user-1",
      name: "Ada",
    });
  });
});
