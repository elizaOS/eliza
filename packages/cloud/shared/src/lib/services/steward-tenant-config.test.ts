/**
 * Fail-closed provisioning behavior for `ensureStewardTenant` (#13417).
 *
 * Previously the fresh-provision POST to Steward `/platform/tenants` collapsed
 * an unparseable response body into `{}` via `.json().catch(() => ({}))`. Two
 * fabricated-success paths fell out of that:
 *   1. A 2xx with a corrupt/unreadable body slipped past the `ok === false`
 *      gate (undefined !== false) and was treated as a successful provision.
 *   2. A 2xx-but-keyless body persisted `steward_tenant_api_key: undefined`
 *      together with `steward_tenant_id`, permanently marking the org
 *      provisioned (so `ensureStewardTenant` never retries) while downstream
 *      calls silently fell back to the shared platform env key instead of the
 *      tenant-scoped key — a tenant-isolation degradation.
 *
 * These tests pin the fail-closed behavior: an unreadable or keyless 2xx now
 * throws (with the caller-recognized "Failed to provision Steward tenant"
 * prefix, so the route maps it to a 502) and NEVER writes a null-keyed org row.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Captured side effects + per-test state ──────────────────────────────────
type OrgRow = {
  id: string;
  slug: string;
  steward_tenant_id?: string | null;
  steward_tenant_api_key?: string | null;
  [k: string]: unknown;
};

let orgRecord: OrgRow | undefined;
const updateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];

mock.module("../../db/repositories/organizations", () => ({
  organizationsRepository: {
    findById: async (_id: string) => orgRecord,
    update: async (id: string, data: Record<string, unknown>) => {
      updateCalls.push({ id, data });
      orgRecord = { ...(orgRecord as OrgRow), ...data, id };
      return orgRecord;
    },
  },
}));

mock.module("./steward-platform-users", () => ({
  getStewardApiUrl: () => "https://steward.example",
  getStewardPlatformKey: () => "platform-key",
  isStewardPlatformConfigured: () => true,
}));

mock.module("../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({
    STEWARD_TENANT_API_KEY: "shared-env-fallback-key",
  }),
}));

// Import AFTER mocks are registered.
const { ensureStewardTenant } = await import("./steward-tenant-config");

const originalFetch = globalThis.fetch;

function stubFetch(res: Response): void {
  globalThis.fetch = (async () => res) as typeof globalThis.fetch;
}

beforeEach(() => {
  updateCalls.length = 0;
  orgRecord = {
    id: "org-1",
    slug: "acme",
    steward_tenant_id: null,
    steward_tenant_api_key: null,
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ensureStewardTenant fail-closed provisioning (#13417)", () => {
  test("2xx with an unreadable body fails closed and does NOT write the org row", async () => {
    // 200 OK but the body is not valid JSON -> .json() rejects.
    stubFetch(new Response("<<not json>>", { status: 200 }));

    await expect(ensureStewardTenant("org-1")).rejects.toThrow(
      /Failed to provision Steward tenant for org org-1: HTTP 200 with unreadable response body/,
    );
    // No org row written: the org must remain un-provisioned so a retry can
    // re-provision cleanly instead of being stuck marked-provisioned.
    expect(updateCalls).toHaveLength(0);
  });

  test("2xx with a valid body but NO apiKey fails closed and does NOT write the org row", async () => {
    // A genuine (parseable) success-shaped body that is nonetheless keyless.
    stubFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(ensureStewardTenant("org-1")).rejects.toThrow(
      /Failed to provision Steward tenant for org org-1: HTTP 200 returned no tenant apiKey/,
    );
    expect(updateCalls).toHaveLength(0);
    // The org never gets silently marked provisioned with a null key.
    expect(orgRecord?.steward_tenant_id).toBeNull();
    expect(orgRecord?.steward_tenant_api_key).toBeNull();
  });

  test("2xx with a blank/whitespace apiKey fails closed (normalizes to no key)", async () => {
    stubFetch(new Response(JSON.stringify({ ok: true, apiKey: "   " }), { status: 200 }));

    await expect(ensureStewardTenant("org-1")).rejects.toThrow(/returned no tenant apiKey/);
    expect(updateCalls).toHaveLength(0);
  });

  test("2xx with a real tenant apiKey succeeds and persists the tenant-scoped key", async () => {
    stubFetch(
      new Response(JSON.stringify({ ok: true, apiKey: "tenant-scoped-key" }), { status: 200 }),
    );

    const result = await ensureStewardTenant("org-1");

    expect(result.isNew).toBe(true);
    expect(result.tenantId).toBe("elizacloud-acme");
    // The returned key is the tenant-scoped key, NOT the shared env fallback.
    expect(result.apiKey).toBe("tenant-scoped-key");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.data).toEqual({
      steward_tenant_id: "elizacloud-acme",
      steward_tenant_api_key: "tenant-scoped-key",
    });
  });

  test("apiKey nested under data.apiKey is accepted (existing contract preserved)", async () => {
    stubFetch(
      new Response(JSON.stringify({ ok: true, data: { apiKey: "nested-key" } }), { status: 200 }),
    );

    const result = await ensureStewardTenant("org-1");
    expect(result.apiKey).toBe("nested-key");
    expect(updateCalls[0]?.data.steward_tenant_api_key).toBe("nested-key");
  });

  test("explicit ok:false still throws the provisioning error (regression guard)", async () => {
    stubFetch(
      new Response(JSON.stringify({ ok: false, error: "quota exceeded" }), { status: 200 }),
    );

    await expect(ensureStewardTenant("org-1")).rejects.toThrow(
      /Failed to provision Steward tenant for org org-1: quota exceeded/,
    );
    expect(updateCalls).toHaveLength(0);
  });

  test("409 (already exists) links the org and uses the env key — unchanged path", async () => {
    stubFetch(new Response(JSON.stringify({ error: "exists" }), { status: 409 }));

    const result = await ensureStewardTenant("org-1");
    expect(result.isNew).toBe(false);
    expect(result.tenantId).toBe("elizacloud-acme");
    expect(result.apiKey).toBe("shared-env-fallback-key");
    // Only the tenant id is linked on the 409 path (no per-tenant key returned).
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.data).toEqual({ steward_tenant_id: "elizacloud-acme" });
  });

  test("409 with an EMPTY/non-JSON body still links the org (parse-guard ordering regression)", async () => {
    // A conflict response commonly has an empty or non-JSON body. The 409 path
    // only needs the status, so it must be handled BEFORE the fail-closed parse
    // guard — otherwise the org is never linked to its already-created tenant.
    stubFetch(new Response("", { status: 409 }));

    const result = await ensureStewardTenant("org-1");
    expect(result.isNew).toBe(false);
    expect(result.tenantId).toBe("elizacloud-acme");
    expect(result.apiKey).toBe("shared-env-fallback-key");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.data).toEqual({ steward_tenant_id: "elizacloud-acme" });
  });

  test("non-ok status with an unreadable body fails closed via the parse guard", async () => {
    // 500 whose body cannot be parsed: the parse guard fires first and fails
    // closed with the unreadable-body message.
    stubFetch(new Response("upstream 500 html", { status: 500 }));

    await expect(ensureStewardTenant("org-1")).rejects.toThrow(
      /Failed to provision Steward tenant for org org-1: HTTP 500 with unreadable response body/,
    );
    expect(updateCalls).toHaveLength(0);
  });
});
