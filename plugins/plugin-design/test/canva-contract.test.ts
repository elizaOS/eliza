/**
 * Exercises the real Canva Connect adapter over HTTP against the repository's
 * protocol-faithful fake upstream speaking Canva wire shapes, including the
 * asynchronous export-job lifecycle. Deterministic; no live Canva account or
 * network access is used.
 */

import {
  type ProviderContractObservation,
  type ProviderProtocolFixture,
  redactProviderDiagnostics,
  runProviderAdapterConformance,
  startFakeProvider,
} from "@elizaos/cloud-test-mocks/provider-contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CanvaDesignAdapter } from "../src/canva.js";
import { DesignError } from "../src/errors.js";

const canvaItem = {
  id: "DAF-design-1",
  title: "Launch Banner",
  thumbnail: { url: "https://document-export.canva.com/thumb/daf1.png" },
  urls: {
    view_url: "https://www.canva.com/design/DAF-design-1/view",
    edit_url: "https://www.canva.com/design/DAF-design-1/edit",
  },
  updated_at: 1_754_000_000,
};

const normalizedItem = {
  provider: "canva",
  providerDesignId: "DAF-design-1",
  name: "Launch Banner",
  deepLinkUrl: "https://www.canva.com/design/DAF-design-1/view",
  thumbnailUrl: "https://document-export.canva.com/thumb/daf1.png",
  updatedAt: new Date(1_754_000_000 * 1_000).toISOString(),
};

const fixtures: ProviderProtocolFixture[] = [
  {
    id: "canva-designs",
    method: "GET",
    path: "/rest/v1/designs",
    response: {
      status: 200,
      body: { items: [canvaItem], continuation: "cont-page-2" },
    },
  },
  {
    id: "canva-design",
    method: "GET",
    path: "/rest/v1/designs/DAF-design-1",
    response: { status: 200, body: { design: canvaItem } },
  },
  {
    id: "canva-export-create",
    method: "POST",
    path: "/rest/v1/exports",
    response: {
      status: 200,
      body: { job: { id: "exp-1", status: "in_progress" } },
    },
  },
  {
    id: "canva-export-poll",
    method: "GET",
    path: "/rest/v1/exports/exp-1",
    response: {
      status: 200,
      body: {
        job: {
          id: "exp-1",
          status: "success",
          urls: ["https://export-download.canva.com/exp-1/page-1.png"],
        },
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

describe("CanvaDesignAdapter provider contract", () => {
  let upstream: Awaited<ReturnType<typeof startFakeProvider>>;
  let adapter: CanvaDesignAdapter;

  beforeAll(async () => {
    upstream = await startFakeProvider({ fixtures });
    adapter = new CanvaDesignAdapter({
      connectionId: upstream.createConnectionId(),
      accessToken: "canva_contract_secret",
      baseUrl: upstream.url,
      timeoutMs: 2_000,
      pollDelayMs: 0,
      testTransport: { fetchImpl: globalThis.fetch },
      allowPrivateNetworkForTests: true,
    });
  });

  afterAll(async () => {
    await upstream.stop();
  });

  it("executes every outbound read and pagination scenario", async () => {
    const report = await runProviderAdapterConformance({
      adapterName: "CanvaDesignAdapter",
      profile: "outbound-http",
      capabilities: ["http-read", "pagination"],
      scenarios: {
        success: async () => {
          const page = await adapter.searchDesigns({ query: "banner" });
          expect(page.designs).toEqual([normalizedItem]);
          expect(page.nextCursor).toBe("cont-page-2");
          return passed("success", "normalized Canva design page inspected");
        },
        "designed-empty": async () => {
          upstream.enqueueFault("GET", "/rest/v1/designs", {
            type: "schema-drift",
            body: { items: [] },
          });
          const page = await adapter.searchDesigns({ query: "nothing" });
          expect(page).toEqual({ designs: [], nextCursor: null });
          return passed(
            "designed-empty",
            "empty listing remained distinct from failure",
          );
        },
        "invalid-input": async () => {
          await expectCode(
            adapter.searchDesigns({ query: " " }),
            "DESIGN_INVALID_INPUT",
          );
          await expectCode(
            adapter.searchDesigns({ query: "banner", limit: 0 }),
            "DESIGN_INVALID_INPUT",
          );
          return passed(
            "invalid-input",
            "blank query and zero limit rejected before HTTP",
          );
        },
        "pagination-cursors": async () => {
          const page = await adapter.searchDesigns({
            query: "banner",
            cursor: "cont-page-1",
          });
          expect(page.nextCursor).toBe("cont-page-2");
          expect(upstream.requests.at(-1)?.query.continuation).toBe(
            "cont-page-1",
          );
          return passed(
            "pagination-cursors",
            "opaque continuation cursors inspected on request and response",
          );
        },
        "rate-limit-retry-metadata": async () => {
          upstream.enqueueFault("GET", "/rest/v1/designs", {
            type: "status",
            status: 429,
            headers: { "retry-after": "5" },
            body: { code: "too_many_requests", message: "Rate limited" },
          });
          const error = await expectCode(
            adapter.searchDesigns({ query: "banner" }),
            "DESIGN_RATE_LIMITED",
          );
          expect(error.retryAfterMs).toBe(5_000);
          return passed(
            "rate-limit-retry-metadata",
            "Retry-After preserved as 5000ms",
          );
        },
        "malformed-json": async () => {
          upstream.enqueueFault("GET", "/rest/v1/designs", {
            type: "malformed-json",
          });
          await expectCode(
            adapter.searchDesigns({ query: "banner" }),
            "DESIGN_MALFORMED_RESPONSE",
          );
          return passed("malformed-json", "invalid provider JSON rejected");
        },
        "schema-drift": async () => {
          upstream.enqueueFault("GET", "/rest/v1/designs", {
            type: "schema-drift",
            body: { items: [{ id: "DAF-design-1" }] },
          });
          await expectCode(
            adapter.searchDesigns({ query: "banner" }),
            "DESIGN_MALFORMED_RESPONSE",
          );
          return passed("schema-drift", "field-dropped listing rejected");
        },
        timeout: async () => {
          const timeoutAdapter = new CanvaDesignAdapter({
            connectionId: "conn_timeout_contract_123",
            accessToken: "canva_timeout",
            baseUrl: "https://canva-timeout.example.test",
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
            timeoutAdapter.searchDesigns({ query: "banner" }),
            "DESIGN_PROVIDER_TIMEOUT",
          );
          return passed("timeout", "bounded abort surfaced as timeout");
        },
        "connection-reset": async () => {
          const resetUpstream = await startFakeProvider({ fixtures });
          const resetAdapter = new CanvaDesignAdapter({
            connectionId: resetUpstream.createConnectionId(),
            accessToken: "canva_reset",
            baseUrl: resetUpstream.url,
            testTransport: { fetchImpl: globalThis.fetch },
            allowPrivateNetworkForTests: true,
          });
          await resetUpstream.resetConnections();
          await expectCode(
            resetAdapter.searchDesigns({ query: "banner" }),
            "DESIGN_PROVIDER_NETWORK",
          );
          return passed(
            "connection-reset",
            "closed upstream surfaced as network failure",
          );
        },
        "provider-4xx": async () => {
          upstream.enqueueFault("GET", "/rest/v1/designs", {
            type: "status",
            status: 400,
            body: { code: "bad_request", message: "Bad request" },
          });
          await expectCode(
            adapter.searchDesigns({ query: "banner" }),
            "DESIGN_PROVIDER_REJECTED",
          );
          return passed("provider-4xx", "provider rejection remained explicit");
        },
        "provider-5xx": async () => {
          upstream.enqueueFault("GET", "/rest/v1/designs", {
            type: "status",
            status: 502,
            body: { code: "internal_error", message: "boom" },
          });
          await expectCode(
            adapter.searchDesigns({ query: "banner" }),
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
          await adapter.searchDesigns({ query: "banner" });
          const diagnostic = redactProviderDiagnostics(upstream.requests, [
            "canva_contract_secret",
          ]);
          expect(JSON.stringify(diagnostic)).not.toContain(
            "canva_contract_secret",
          );
          return passed(
            "secret-redaction",
            "recorded requests redact bearer credentials",
            { diagnostic },
          );
        },
        "read-policy": async () => {
          const page = await adapter.searchDesigns({
            query: "banner",
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
    expect(report.observations).toHaveLength(14);
  });

  it("keeps expired, revoked, and plan-limited authorization failures distinct", async () => {
    upstream.enqueueFault("GET", "/rest/v1/designs", {
      type: "status",
      status: 401,
      body: { code: "expired_token", message: "Token expired" },
    });
    await expectCode(
      adapter.searchDesigns({ query: "banner" }),
      "DESIGN_AUTH_EXPIRED",
    );

    upstream.enqueueFault("GET", "/rest/v1/designs", {
      type: "status",
      status: 403,
      body: { code: "revoked_token", message: "Token revoked" },
    });
    await expectCode(
      adapter.searchDesigns({ query: "banner" }),
      "DESIGN_AUTH_REVOKED",
    );

    upstream.enqueueFault("GET", "/rest/v1/designs", {
      type: "status",
      status: 403,
      body: { code: "license_required", message: "Premium required" },
    });
    await expectCode(
      adapter.searchDesigns({ query: "banner" }),
      "DESIGN_PLAN_LIMITED",
    );
  });

  it("resolves detail, missing designs, and the asynchronous export job", async () => {
    await expect(adapter.getDesign("DAF-design-1")).resolves.toEqual(
      normalizedItem,
    );
    await expect(adapter.getDesign("DAF-missing")).resolves.toBeNull();

    const artifact = await adapter.exportDesign({
      providerDesignId: "DAF-design-1",
      format: "png",
    });
    expect(artifact).toEqual({
      provider: "canva",
      providerDesignId: "DAF-design-1",
      format: "png",
      urls: ["https://export-download.canva.com/exp-1/page-1.png"],
    });
    const create = upstream.requests.find(
      (request) =>
        request.method === "POST" && request.path === "/rest/v1/exports",
    );
    expect(create?.body).toContain('"design_id":"DAF-design-1"');
  });

  it("classifies failed export jobs, plan-limited exports, and stuck jobs", async () => {
    upstream.enqueueFault("GET", "/rest/v1/exports/exp-1", {
      type: "schema-drift",
      body: {
        job: {
          id: "exp-1",
          status: "failed",
          error: { code: "internal_failure", message: "render failed" },
        },
      },
    });
    await expectCode(
      adapter.exportDesign({ providerDesignId: "DAF-design-1", format: "png" }),
      "DESIGN_EXPORT_FAILED",
    );

    upstream.enqueueFault("GET", "/rest/v1/exports/exp-1", {
      type: "schema-drift",
      body: {
        job: {
          id: "exp-1",
          status: "failed",
          error: { code: "license_required", message: "premium element" },
        },
      },
    });
    await expectCode(
      adapter.exportDesign({ providerDesignId: "DAF-design-1", format: "png" }),
      "DESIGN_PLAN_LIMITED",
    );

    const stuck = new CanvaDesignAdapter({
      connectionId: upstream.createConnectionId(),
      accessToken: "canva_stuck",
      baseUrl: upstream.url,
      pollDelayMs: 0,
      maxPollAttempts: 2,
      testTransport: { fetchImpl: globalThis.fetch },
      allowPrivateNetworkForTests: true,
    });
    for (let i = 0; i < 2; i += 1) {
      upstream.enqueueFault("GET", "/rest/v1/exports/exp-1", {
        type: "schema-drift",
        body: { job: { id: "exp-1", status: "in_progress" } },
      });
    }
    await expectCode(
      stuck.exportDesign({ providerDesignId: "DAF-design-1", format: "png" }),
      "DESIGN_PROVIDER_TIMEOUT",
    );
  });

  it("rejects unsupported capabilities and off-domain deep links", async () => {
    await expectCode(adapter.listComments(), "DESIGN_UNSUPPORTED");
    await expectCode(
      adapter.exportDesign({ providerDesignId: "DAF-design-1", format: "svg" }),
      "DESIGN_UNSUPPORTED",
    );

    upstream.enqueueFault("GET", "/rest/v1/designs", {
      type: "schema-drift",
      body: {
        items: [
          {
            ...canvaItem,
            urls: { view_url: "https://evil.example.test/design" },
          },
        ],
      },
    });
    await expectCode(
      adapter.searchDesigns({ query: "banner" }),
      "DESIGN_MALFORMED_RESPONSE",
    );
  });
});
