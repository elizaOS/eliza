/**
 * Covers the account domain search/inventory and project DNS read actions.
 *
 * The actions and resolution logic run for real while the shared fake replaces
 * only the typed Cloud SDK boundary.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  FakeElizaCloudClient,
  installTestProjectRegistry,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setGetApp,
  setListAppDomainDnsRecords,
  setListManagedDomains,
  setSearchDomains,
  type TestProjectRegistry,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));

const { searchDomainsAction } = await import(
  "../src/actions/search-domains.ts"
);
const { listManagedDomainsAction } = await import(
  "../src/actions/list-managed-domains.ts"
);
const { listDomainDnsRecordsAction } = await import(
  "../src/actions/list-domain-dns-records.ts"
);
const { cloudAppsPlugin } = await import("../src/index.ts");

const APP = makeApp({
  name: "Habit Tracker",
  slug: "habit-tracker",
});
const OTHER_APP = makeApp({
  id: "00000000-0000-0000-0000-000000000002",
  name: "Meal Planner",
  slug: "meal-planner",
});
let registry: TestProjectRegistry;

function installProjects(
  entries: Array<{ name: string; cloudAppId?: string }>,
  activeIndex?: number | null,
): void {
  registry?.cleanup();
  registry = installTestProjectRegistry(entries, { activeIndex });
}

class TestCloudError extends Error {
  readonly statusCode: number;
  readonly errorBody: { error: string };

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorBody = { error: message };
  }
}

beforeEach(() => {
  resetSdk();
  installProjects([{ name: "Habit Tracker", cloudAppId: APP.id }]);
  setGetApp((id) =>
    Promise.resolve({
      success: true,
      app: id === OTHER_APP.id ? OTHER_APP : APP,
    }),
  );
});

afterEach(() => registry.cleanup());

describe("read-safe domain broker parity", () => {
  it("registers all three parent actions", () => {
    const names = new Set(
      cloudAppsPlugin.actions?.map((action) => action.name) ?? [],
    );
    expect(names.has("SEARCH_DOMAINS")).toBe(true);
    expect(names.has("LIST_MANAGED_DOMAINS")).toBe(true);
    expect(names.has("LIST_DOMAIN_DNS_RECORDS")).toBe(true);
  });

  it("gates all three actions on Cloud credentials", async () => {
    for (const action of [
      searchDomainsAction,
      listManagedDomainsAction,
      listDomainDnsRecordsAction,
    ]) {
      expect(await action.validate?.(keyedRuntime(), makeMessage("x"))).toBe(
        true,
      );
      expect(await action.validate?.(unkeyedRuntime(), makeMessage("x"))).toBe(
        false,
      );
    }
  });
});

describe("SEARCH_DOMAINS", () => {
  it("reports missing Cloud credentials without calling the SDK", async () => {
    const result = await searchDomainsAction.handler?.(
      unkeyedRuntime(),
      makeMessage("search domains"),
      undefined,
      { query: "habit" },
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_key");
  });

  it("sends the bounded structured query and returns priced suggestions", async () => {
    let received: { query: string; limit?: number } | undefined;
    setSearchDomains((input) => {
      received = input;
      return Promise.resolve({
        success: true,
        query: input.query,
        candidates: [
          {
            domain: "habit.tools",
            available: true,
            currency: "USD",
            years: 1,
            price: {
              wholesaleUsdCents: 1000,
              marginUsdCents: 360,
              totalUsdCents: 1360,
              marginBps: 3600,
            },
          },
          {
            domain: "habit.app",
            available: false,
            reason: "domain_unavailable",
            currency: "USD",
            years: 1,
            price: null,
          },
        ],
      });
    });

    const result = await searchDomainsAction.handler?.(
      keyedRuntime(),
      makeMessage("find some names"),
      undefined,
      { parameters: { query: "habit", limit: 5 } },
    );

    expect(received).toEqual({ query: "habit", limit: 5 });
    expect(result?.success).toBe(true);
    expect(result?.verifiedUserFacing).toBe(true);
    expect(result?.userFacingText).toContain("habit.tools");
    expect(result?.userFacingText).toContain("$13.60");
    expect(result?.userFacingText).toContain("habit.app — unavailable");
    expect(result?.data?.candidates).toEqual([
      {
        domain: "habit.tools",
        available: true,
        reason: null,
        currency: "USD",
        years: 1,
        priceUsdCents: 1360,
      },
      {
        domain: "habit.app",
        available: false,
        reason: "domain_unavailable",
        currency: "USD",
        years: 1,
        priceUsdCents: null,
      },
    ]);
  });

  it("distinguishes missing, invalid, and valid-empty searches", async () => {
    const missing = await searchDomainsAction.handler?.(
      keyedRuntime(),
      makeMessage("search domains"),
    );
    expect(missing?.success).toBe(false);
    expect(missing?.data?.reason).toBe("missing_query");

    const invalid = await searchDomainsAction.handler?.(
      keyedRuntime(),
      makeMessage("search domains"),
      undefined,
      { query: "habit", limit: 21 },
    );
    expect(invalid?.success).toBe(false);
    expect(invalid?.data?.reason).toBe("invalid_query");

    const empty = await searchDomainsAction.handler?.(
      keyedRuntime(),
      makeMessage("search domains"),
      undefined,
      { query: "no-candidates", limit: 3 },
    );
    expect(empty?.success).toBe(true);
    expect(empty?.data?.candidates).toEqual([]);
    expect(empty?.userFacingText).toContain("no domain suggestions");
  });

  it("rejects malformed success data and surfaces transport failures", async () => {
    setSearchDomains((input) =>
      Promise.resolve({
        success: true,
        query: input.query,
        candidates: [
          {
            domain: "broken.example",
            available: true,
            currency: "USD",
            years: 1,
            price: null,
          },
        ],
      }),
    );
    const malformed = await searchDomainsAction.handler?.(
      keyedRuntime(),
      makeMessage("search"),
      undefined,
      { query: "broken" },
    );
    expect(malformed?.success).toBe(false);
    expect(malformed?.data?.reason).toBe("error");

    setSearchDomains(() => Promise.reject(new Error("offline")));
    const offline = await searchDomainsAction.handler?.(
      keyedRuntime(),
      makeMessage("search"),
      undefined,
      { query: "habit" },
    );
    expect(offline?.success).toBe(false);
    expect(offline?.data?.reason).toBe("error");
  });
});

describe("LIST_MANAGED_DOMAINS", () => {
  it("reports missing Cloud credentials without fabricating an inventory", async () => {
    const result = await listManagedDomainsAction.handler?.(
      unkeyedRuntime(),
      makeMessage("list domains"),
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_key");
  });

  it("returns account-wide assignments without exposing Cloudflare zone ids", async () => {
    setListManagedDomains(() =>
      Promise.resolve({
        success: true,
        domains: [
          {
            id: "domain-1",
            domain: "habit.tools",
            registrar: "cloudflare",
            status: "active",
            verified: true,
            sslStatus: "active",
            expiresAt: "2027-07-23T00:00:00.000Z",
            autoRenew: true,
            resourceType: "app",
            appId: APP.id,
            containerId: null,
            agentId: null,
            mcpId: null,
            cloudflareZoneId: "zone-secret",
          },
          {
            id: "domain-2",
            domain: "notes.example",
            registrar: "external",
            status: "pending",
            verified: false,
            sslStatus: null,
            expiresAt: null,
            autoRenew: false,
            resourceType: null,
            appId: null,
            containerId: null,
            agentId: null,
            mcpId: null,
            cloudflareZoneId: null,
          },
        ],
      }),
    );

    const result = await listManagedDomainsAction.handler?.(
      keyedRuntime(),
      makeMessage("list every domain"),
    );

    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("2 managed domains");
    expect(result?.userFacingText).toContain("assigned to a published project");
    expect(result?.userFacingText).toContain("not assigned");
    expect(JSON.stringify(result?.data)).not.toContain("zone-secret");
    expect(result?.data?.domains).toMatchObject([
      {
        domain: "habit.tools",
        assignment: { type: "app", id: APP.id },
      },
      { domain: "notes.example", assignment: null },
    ]);
  });

  it("renders a designed empty state and rejects broken assignments", async () => {
    const empty = await listManagedDomainsAction.handler?.(
      keyedRuntime(),
      makeMessage("list domains"),
    );
    expect(empty?.success).toBe(true);
    expect(empty?.data?.domains).toEqual([]);

    setListManagedDomains(() =>
      Promise.resolve({
        success: true,
        domains: [
          {
            id: "domain-1",
            domain: "habit.tools",
            registrar: "cloudflare",
            status: "active",
            verified: true,
            sslStatus: "active",
            expiresAt: null,
            autoRenew: true,
            resourceType: "app",
            appId: null,
            containerId: null,
            agentId: null,
            mcpId: null,
            cloudflareZoneId: "zone-1",
          },
        ],
      }),
    );
    const malformed = await listManagedDomainsAction.handler?.(
      keyedRuntime(),
      makeMessage("list domains"),
    );
    expect(malformed?.success).toBe(false);
    expect(malformed?.data?.reason).toBe("error");
  });
});

describe("LIST_DOMAIN_DNS_RECORDS", () => {
  it("resolves a project and returns the complete DNS record fields", async () => {
    let received: { appId: string; domain: string } | undefined;
    setListAppDomainDnsRecords((appId, domain) => {
      received = { appId, domain };
      return Promise.resolve({
        success: true,
        domain,
        records: [
          {
            id: "dns-1",
            type: "A",
            name: "habit.tools",
            content: "192.0.2.10",
            ttl: 1,
            proxied: true,
            createdOn: "2026-07-23T00:00:00.000Z",
            modifiedOn: "2026-07-23T00:00:00.000Z",
          },
          {
            id: "dns-2",
            type: "MX",
            name: "habit.tools",
            content: "mail.example.net",
            ttl: 3600,
            proxied: false,
            priority: 10,
          },
        ],
      });
    });

    const result = await listDomainDnsRecordsAction.handler?.(
      keyedRuntime(),
      makeMessage("show its DNS"),
      undefined,
      {
        parameters: {
          domain: "HABIT.TOOLS",
          project: "Habit Tracker",
        },
      },
    );

    expect(received).toEqual({ appId: APP.id, domain: "habit.tools" });
    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("A habit.tools → 192.0.2.10");
    expect(result?.userFacingText).toContain("priority 10");
    expect(result?.data?.project).toEqual({
      id: registry.projects[0].id,
      cloudAppId: APP.id,
      name: "Habit Tracker",
    });
    expect(result?.data?.app).toEqual({
      id: APP.id,
      name: APP.name,
      slug: APP.slug,
    });
    expect(result?.data?.records).toHaveLength(2);
  });

  it("requires one domain and refuses to guess among several projects", async () => {
    const missing = await listDomainDnsRecordsAction.handler?.(
      keyedRuntime(),
      makeMessage("show DNS records"),
    );
    expect(missing?.success).toBe(false);
    expect(missing?.data?.reason).toBe("no_domain");

    const manyDomains = await listDomainDnsRecordsAction.handler?.(
      keyedRuntime(),
      makeMessage("compare one.example and two.example"),
    );
    expect(manyDomains?.success).toBe(false);
    expect(manyDomains?.data?.reason).toBe("ambiguous_domain");

    installProjects([
      { name: "Habit Tracker", cloudAppId: APP.id },
      { name: "Meal Planner", cloudAppId: OTHER_APP.id },
    ]);
    const manyProjects = await listDomainDnsRecordsAction.handler?.(
      keyedRuntime(),
      makeMessage("show DNS records for habit.tools"),
      undefined,
      { domain: "habit.tools" },
    );
    expect(manyProjects?.success).toBe(false);
    expect(manyProjects?.data?.reason).toBe("no_active");
    expect(manyProjects?.userFacingText).toContain("Select an active project");
  });

  it("distinguishes external-provider and unattached-domain errors", async () => {
    setListAppDomainDnsRecords(() =>
      Promise.reject(
        new TestCloudError(
          409,
          "DNS records on external domains must be edited elsewhere",
        ),
      ),
    );
    const external = await listDomainDnsRecordsAction.handler?.(
      keyedRuntime(),
      makeMessage("show DNS for notes.example"),
      undefined,
      { domain: "notes.example" },
    );
    expect(external?.success).toBe(false);
    expect(external?.data?.reason).toBe("external_dns_provider");
    expect(external?.userFacingText).toContain("external DNS provider");

    setListAppDomainDnsRecords(() =>
      Promise.reject(new TestCloudError(404, "not attached")),
    );
    const missing = await listDomainDnsRecordsAction.handler?.(
      keyedRuntime(),
      makeMessage("show DNS for notes.example"),
      undefined,
      { domain: "notes.example" },
    );
    expect(missing?.success).toBe(false);
    expect(missing?.data?.reason).toBe("not_attached");
  });

  it("distinguishes empty DNS, no projects, and transport failures", async () => {
    const empty = await listDomainDnsRecordsAction.handler?.(
      keyedRuntime(),
      makeMessage("show DNS"),
      undefined,
      { project: "Habit Tracker", domain: "habit.tools" },
    );
    expect(empty?.success).toBe(true);
    expect(empty?.data?.records).toEqual([]);

    installProjects([]);
    const noProjects = await listDomainDnsRecordsAction.handler?.(
      keyedRuntime(),
      makeMessage("show DNS"),
      undefined,
      { domain: "habit.tools" },
    );
    expect(noProjects?.success).toBe(false);
    expect(noProjects?.data?.reason).toBe("no_projects");

    installProjects([{ name: "Habit Tracker", cloudAppId: APP.id }]);
    setListAppDomainDnsRecords(() => Promise.reject(new Error("offline")));
    const offline = await listDomainDnsRecordsAction.handler?.(
      keyedRuntime(),
      makeMessage("show DNS"),
      undefined,
      { project: "Habit Tracker", domain: "habit.tools" },
    );
    expect(offline?.success).toBe(false);
    expect(offline?.data?.reason).toBe("error");
  });

  it("rejects mismatched Cloud data and reports missing credentials", async () => {
    setListAppDomainDnsRecords(() =>
      Promise.resolve({
        success: true,
        domain: "other.example",
        records: [],
      }),
    );
    const mismatched = await listDomainDnsRecordsAction.handler?.(
      keyedRuntime(),
      makeMessage("show DNS"),
      undefined,
      { domain: "habit.tools" },
    );
    expect(mismatched?.success).toBe(false);
    expect(mismatched?.data?.reason).toBe("error");

    const noKey = await listDomainDnsRecordsAction.handler?.(
      unkeyedRuntime(),
      makeMessage("show DNS"),
      undefined,
      { domain: "habit.tools" },
    );
    expect(noKey?.success).toBe(false);
    expect(noKey?.data?.reason).toBe("no_key");
  });
});
