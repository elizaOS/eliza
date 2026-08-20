/**
 * Exercises the real Figma REST adapter over HTTP against the repository's
 * protocol-faithful fake upstream speaking Figma wire shapes. Deterministic;
 * no live Figma account or network access is used.
 */

import {
  type ProviderContractObservation,
  type ProviderProtocolFixture,
  redactProviderDiagnostics,
  runProviderAdapterConformance,
  startFakeProvider,
} from "@elizaos/cloud-test-mocks/provider-contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DesignError } from "../src/errors.js";
import { FigmaDesignAdapter } from "../src/figma.js";

const projectFile = {
  key: "FKEY123",
  name: "Launch Poster",
  thumbnail_url: "https://s3-alpha.figma.com/thumbnails/fkey123.png",
  last_modified: "2026-08-01T12:00:00Z",
};

const fixtures: ProviderProtocolFixture[] = [
  {
    id: "figma-project-files",
    method: "GET",
    path: "/v1/projects/123/files",
    response: {
      status: 200,
      body: {
        files: [
          projectFile,
          {
            key: "OTHER",
            name: "Roadmap",
            last_modified: "2026-08-02T00:00:00Z",
          },
        ],
      },
    },
  },
  {
    id: "figma-file",
    method: "GET",
    path: "/v1/files/FKEY123",
    response: {
      status: 200,
      body: {
        name: "Launch Poster",
        lastModified: "2026-08-01T12:00:00Z",
        thumbnailUrl: "https://s3-alpha.figma.com/thumbnails/fkey123.png",
        version: "42",
      },
    },
  },
  {
    id: "figma-images",
    method: "GET",
    path: "/v1/images/FKEY123",
    response: {
      status: 200,
      body: {
        err: null,
        images: {
          "1:2":
            "https://figma-alpha-api.s3.us-west-2.amazonaws.com/render/1-2.png",
        },
      },
    },
  },
  {
    id: "figma-comments",
    method: "GET",
    path: "/v1/files/FKEY123/comments",
    response: {
      status: 200,
      body: {
        comments: [
          {
            id: "c-1",
            message: "Bump the headline size",
            user: { handle: "reviewer" },
            created_at: "2026-08-03T09:00:00Z",
            resolved_at: null,
          },
        ],
      },
    },
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
  code: DesignError["code"],
): Promise<DesignError> {
  try {
    await operation;
  } catch (error) {
    // error-policy:J1 The test assertion boundary verifies the typed failure
    // returned by the real adapter instead of allowing it to escape the case.
    expect(error).toBeInstanceOf(DesignError);
    expect((error as DesignError).code).toBe(code);
    return error as DesignError;
  }
  throw new Error(`Expected ${code}`);
}

describe("FigmaDesignAdapter provider contract", () => {
  let upstream: Awaited<ReturnType<typeof startFakeProvider>>;
  let adapter: FigmaDesignAdapter;

  beforeAll(async () => {
    upstream = await startFakeProvider({ fixtures });
    adapter = new FigmaDesignAdapter({
      connectionId: upstream.createConnectionId(),
      personalAccessToken: "figd_contract_secret",
      projectId: "123",
      baseUrl: upstream.url,
      timeoutMs: 2_000,
      testTransport: { fetchImpl: globalThis.fetch },
      allowPrivateNetworkForTests: true,
    });
  });

  afterAll(async () => {
    await upstream.stop();
  });

  it("executes every outbound read scenario", async () => {
    const report = await runProviderAdapterConformance({
      adapterName: "FigmaDesignAdapter",
      profile: "outbound-http",
      capabilities: ["http-read"],
      scenarios: {
        success: async () => {
          const page = await adapter.searchDesigns({ query: "poster" });
          expect(page.designs).toEqual([
            {
              provider: "figma",
              providerDesignId: "FKEY123",
              name: "Launch Poster",
              deepLinkUrl: "https://www.figma.com/design/FKEY123",
              thumbnailUrl: projectFile.thumbnail_url,
              updatedAt: "2026-08-01T12:00:00.000Z",
            },
          ]);
          expect(page.nextCursor).toBeNull();
          return passed("success", "normalized Figma project file inspected");
        },
        "designed-empty": async () => {
          const page = await adapter.searchDesigns({ query: "no-such-name" });
          expect(page).toEqual({ designs: [], nextCursor: null });
          return passed(
            "designed-empty",
            "unmatched query produced an empty page distinct from failure",
          );
        },
        "invalid-input": async () => {
          await expectCode(
            adapter.searchDesigns({ query: " " }),
            "DESIGN_INVALID_INPUT",
          );
          await expectCode(
            adapter.searchDesigns({ query: "poster", cursor: "page-2" }),
            "DESIGN_INVALID_INPUT",
          );
          return passed(
            "invalid-input",
            "blank query and unsupported cursor rejected before HTTP",
          );
        },
        "rate-limit-retry-metadata": async () => {
          upstream.enqueueFault("GET", "/v1/projects/123/files", {
            type: "status",
            status: 429,
            headers: { "retry-after": "3" },
            body: { status: 429, err: "Rate limit exceeded" },
          });
          const error = await expectCode(
            adapter.searchDesigns({ query: "poster" }),
            "DESIGN_RATE_LIMITED",
          );
          expect(error.retryAfterMs).toBe(3_000);
          return passed(
            "rate-limit-retry-metadata",
            "Retry-After preserved as 3000ms",
          );
        },
        "malformed-json": async () => {
          upstream.enqueueFault("GET", "/v1/projects/123/files", {
            type: "malformed-json",
          });
          await expectCode(
            adapter.searchDesigns({ query: "poster" }),
            "DESIGN_MALFORMED_RESPONSE",
          );
          return passed("malformed-json", "invalid provider JSON rejected");
        },
        "schema-drift": async () => {
          upstream.enqueueFault("GET", "/v1/projects/123/files", {
            type: "schema-drift",
            body: { files: [{ key: "FKEY123" }] },
          });
          await expectCode(
            adapter.searchDesigns({ query: "poster" }),
            "DESIGN_MALFORMED_RESPONSE",
          );
          return passed("schema-drift", "field-dropped listing rejected");
        },
        timeout: async () => {
          const timeoutAdapter = new FigmaDesignAdapter({
            connectionId: "conn_timeout_contract_123",
            personalAccessToken: "figd_timeout",
            projectId: "123",
            baseUrl: "https://figma-timeout.example.test",
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
            timeoutAdapter.searchDesigns({ query: "poster" }),
            "DESIGN_PROVIDER_TIMEOUT",
          );
          return passed("timeout", "bounded abort surfaced as timeout");
        },
        "connection-reset": async () => {
          const resetUpstream = await startFakeProvider({ fixtures });
          const resetAdapter = new FigmaDesignAdapter({
            connectionId: resetUpstream.createConnectionId(),
            personalAccessToken: "figd_reset",
            projectId: "123",
            baseUrl: resetUpstream.url,
            testTransport: { fetchImpl: globalThis.fetch },
            allowPrivateNetworkForTests: true,
          });
          await resetUpstream.resetConnections();
          await expectCode(
            resetAdapter.searchDesigns({ query: "poster" }),
            "DESIGN_PROVIDER_NETWORK",
          );
          return passed(
            "connection-reset",
            "closed upstream surfaced as network failure",
          );
        },
        "provider-4xx": async () => {
          upstream.enqueueFault("GET", "/v1/projects/123/files", {
            type: "status",
            status: 400,
            body: { status: 400, err: "Bad request" },
          });
          await expectCode(
            adapter.searchDesigns({ query: "poster" }),
            "DESIGN_PROVIDER_REJECTED",
          );
          return passed("provider-4xx", "provider rejection remained explicit");
        },
        "provider-5xx": async () => {
          upstream.enqueueFault("GET", "/v1/projects/123/files", {
            type: "status",
            status: 503,
            body: { status: 503, err: "unavailable" },
          });
          await expectCode(
            adapter.searchDesigns({ query: "poster" }),
            "DESIGN_PROVIDER_FAILURE",
          );
          return passed("provider-5xx", "provider outage remained explicit");
        },
        "opaque-connection-id": async () =>
          passed(
            "opaque-connection-id",
            "adapter exposes only an opaque connection handle",
            { connectionId: adapter.connectionId },
          ),
        "secret-redaction": async () => {
          await adapter.searchDesigns({ query: "poster" });
          const diagnostic = redactProviderDiagnostics(upstream.requests, [
            "figd_contract_secret",
          ]);
          expect(JSON.stringify(diagnostic)).not.toContain(
            "figd_contract_secret",
          );
          return passed(
            "secret-redaction",
            "recorded requests redact the personal access token",
            { diagnostic },
          );
        },
        "read-policy": async () => {
          const page = await adapter.searchDesigns({
            query: "poster",
            limit: 1,
          });
          expect(page.designs).toHaveLength(1);
          return passed(
            "read-policy",
            "read completed without mutation receipt",
          );
        },
      },
    });
    expect(report.observations).toHaveLength(13);
  });

  it("keeps expired, revoked, and plan-limited authorization failures distinct", async () => {
    upstream.enqueueFault("GET", "/v1/projects/123/files", {
      type: "status",
      status: 403,
      body: { status: 403, err: "Token expired" },
    });
    await expectCode(
      adapter.searchDesigns({ query: "poster" }),
      "DESIGN_AUTH_EXPIRED",
    );

    upstream.enqueueFault("GET", "/v1/projects/123/files", {
      type: "status",
      status: 403,
      body: { status: 403, err: "Invalid token" },
    });
    await expectCode(
      adapter.searchDesigns({ query: "poster" }),
      "DESIGN_AUTH_REVOKED",
    );

    upstream.enqueueFault("GET", "/v1/projects/123/files", {
      type: "status",
      status: 403,
      body: { status: 403, err: "Limited by plan tier" },
    });
    await expectCode(
      adapter.searchDesigns({ query: "poster" }),
      "DESIGN_PLAN_LIMITED",
    );
  });

  it("resolves file detail, missing files, exports, and comments", async () => {
    const detail = await adapter.getDesign("FKEY123");
    expect(detail).toEqual({
      provider: "figma",
      providerDesignId: "FKEY123",
      name: "Launch Poster",
      deepLinkUrl: "https://www.figma.com/design/FKEY123",
      thumbnailUrl: projectFile.thumbnail_url,
      updatedAt: "2026-08-01T12:00:00.000Z",
    });
    await expect(adapter.getDesign("MISSING")).resolves.toBeNull();

    const artifact = await adapter.exportDesign({
      providerDesignId: "FKEY123",
      format: "png",
      nodeId: "1:2",
      scale: 2,
    });
    expect(artifact).toEqual({
      provider: "figma",
      providerDesignId: "FKEY123",
      format: "png",
      urls: [
        "https://figma-alpha-api.s3.us-west-2.amazonaws.com/render/1-2.png",
      ],
    });
    const lastRequest = upstream.requests.at(-1);
    expect(lastRequest?.query.ids).toBe("1:2");
    expect(lastRequest?.query.format).toBe("png");
    expect(lastRequest?.query.scale).toBe("2");

    const comments = await adapter.listComments("FKEY123");
    expect(comments).toEqual({
      comments: [
        {
          provider: "figma",
          commentId: "c-1",
          message: "Bump the headline size",
          author: "reviewer",
          createdAt: "2026-08-03T09:00:00.000Z",
          resolved: false,
        },
      ],
      nextCursor: null,
    });
  });

  it("surfaces provider-declared render failures and null render URLs", async () => {
    upstream.enqueueFault("GET", "/v1/images/FKEY123", {
      type: "schema-drift",
      body: { err: "Render timeout", images: {} },
    });
    await expectCode(
      adapter.exportDesign({
        providerDesignId: "FKEY123",
        format: "png",
        nodeId: "1:2",
      }),
      "DESIGN_EXPORT_FAILED",
    );

    upstream.enqueueFault("GET", "/v1/images/FKEY123", {
      type: "schema-drift",
      body: { err: null, images: { "1:2": null } },
    });
    await expectCode(
      adapter.exportDesign({
        providerDesignId: "FKEY123",
        format: "png",
        nodeId: "1:2",
      }),
      "DESIGN_EXPORT_FAILED",
    );
  });

  it("requires a nodeId for exports and rejects malformed requests before I/O", async () => {
    const transport = vi.fn(async () => Response.json({}));
    const strict = new FigmaDesignAdapter({
      connectionId: "conn_strict_boundary_1234",
      personalAccessToken: "figd_strict",
      baseUrl: "https://figma-strict.example.test",
      testTransport: { fetchImpl: transport },
    });
    await expectCode(
      strict.exportDesign({ providerDesignId: "FKEY123", format: "png" }),
      "DESIGN_INVALID_INPUT",
    );
    await expectCode(
      strict.exportDesign({
        providerDesignId: "FKEY123",
        format: "png",
        nodeId: "1:2",
        scale: 100,
      }),
      "DESIGN_INVALID_INPUT",
    );
    await expectCode(strict.getDesign(""), "DESIGN_INVALID_INPUT");
    await expectCode(
      strict.searchDesigns({ query: "poster" }),
      "DESIGN_UNSUPPORTED",
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("blocks unsafe endpoints, DNS rebinding, and redirects", async () => {
    for (const baseUrl of [
      "http://169.254.169.254/",
      "https://127.0.0.1/",
      "https://user:pass@figma.example.test/",
      "https://figma.example.test/?token=secret",
    ]) {
      expect(
        () =>
          new FigmaDesignAdapter({
            connectionId: "conn_blocked_endpoint_123",
            personalAccessToken: "figd_blocked",
            baseUrl,
          }),
      ).toThrow(DesignError);
    }

    const pinnedFetch = vi.fn(async () => new Response("{}"));
    const rebinding = new FigmaDesignAdapter({
      connectionId: "conn_rebinding_guard_123",
      personalAccessToken: "figd_rebind",
      baseUrl: "https://figma-rebind.example.test",
      testTransport: {
        lookupFn: async () => [{ address: "169.254.169.254", family: 4 }],
        pinnedFetchImpl: pinnedFetch,
      },
    });
    await expectCode(rebinding.getDesign("FKEY123"), "DESIGN_ENDPOINT_BLOCKED");
    expect(pinnedFetch).not.toHaveBeenCalled();

    const requests: Array<{ url: string; token: string | null }> = [];
    const redirects = new FigmaDesignAdapter({
      connectionId: "conn_redirect_guard_1234",
      personalAccessToken: "must_not_cross_origin",
      baseUrl: "https://figma-redirect.example.test",
      testTransport: {
        fetchImpl: vi.fn(async (input, init) => {
          requests.push({
            url: String(input),
            token: new Headers(init?.headers).get("x-figma-token"),
          });
          return new Response(null, {
            status: 302,
            headers: { location: "https://other-origin.example.test/steal" },
          });
        }),
      },
    });
    await expectCode(redirects.getDesign("FKEY123"), "DESIGN_PROVIDER_NETWORK");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("figma-redirect.example.test");
  });

  it("bounds oversized response bodies", async () => {
    const oversized = new FigmaDesignAdapter({
      connectionId: "conn_response_bound_1234",
      personalAccessToken: "figd_bounded",
      projectId: "123",
      baseUrl: "https://figma-bounded.example.test",
      responseByteLimit: 8,
      testTransport: {
        fetchImpl: vi.fn(
          async () => new Response('{"files":[]}', { status: 200 }),
        ),
      },
    });
    await expectCode(
      oversized.searchDesigns({ query: "poster" }),
      "DESIGN_RESPONSE_TOO_LARGE",
    );
  });
});
