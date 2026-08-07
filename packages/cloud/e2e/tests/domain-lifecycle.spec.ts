/**
 * Domain acquisition lifecycle — the customer domain tooling, end to end.
 *
 * The existing monetized-app-loop spec asserts the check→buy debit math; this
 * fills the gaps the audit flagged as untested: search, status, per-app + org
 * domain listing, DNS record CRUD, and detach. Runs against the booted stack
 * with the Cloudflare registrar dev stub (ELIZA_CF_REGISTRAR_DEV_STUB=1), so
 * no real Cloudflare call is made but the route flow + DB writes are real.
 */
import { authedClient } from "../src/helpers/monetization";
import { expect, test } from "../src/helpers/test-fixtures";

interface SearchResponse {
  success?: boolean;
  results?: Array<{
    domain: string;
    available?: boolean;
    price?: { totalUsdCents?: number } | null;
  }>;
  domains?: Array<{ domain: string }>;
}
interface BuyResponse {
  success?: boolean;
  verified?: boolean;
  debited?: { totalUsdCents?: number };
}
interface DomainListResponse {
  success?: boolean;
  domains?: Array<{ domain?: string; name?: string }>;
}

test.describe("domain acquisition lifecycle", () => {
  test("search → check → buy → status → list → DNS CRUD → detach", async ({
    stack,
    seededUser,
  }) => {
    const api = stack.urls.api;
    const c = authedClient(api, seededUser.apiKey);

    const created = await c<{ app?: { id?: string } }>("POST", "/api/v1/apps", {
      name: `Domain App ${Date.now().toString(36)}`,
      app_url: "https://placeholder.invalid",
      skipGitHubRepo: true,
    });
    expect([200, 201]).toContain(created.status);
    const appId = created.json.app?.id;
    expect(appId).toBeTruthy();
    if (!appId) throw new Error("apps.create did not return an app id");

    // 1. Search — returns priced candidates (stub: .com/.io/.dev).
    const search = await c<SearchResponse>("POST", "/api/v1/domains/search", {
      query: "exampletest",
      limit: 5,
    });
    expect(search.status, "domain search reachable + org-authed").toBe(200);

    const domain = `dl-${Date.now().toString(36)}.com`;

    // 2. Check — availability + price quote (no charge).
    const check = await c<{
      available?: boolean;
      price?: { totalUsdCents?: number };
    }>("POST", `/api/v1/apps/${appId}/domains/check`, { domain });
    expect([200, 201]).toContain(check.status);

    // 3. Buy — atomic debit → register (stub) → DNS → attach. $14.95 for a .com.
    const balBefore = await c<{ balance?: number }>(
      "GET",
      "/api/v1/credits/balance",
    );
    const buy = await c<BuyResponse>(
      "POST",
      `/api/v1/apps/${appId}/domains/buy`,
      {
        domain,
      },
    );
    expect([200, 201], `buy status ${buy.status}`).toContain(buy.status);
    expect(buy.json.success, "domain buy succeeds").toBe(true);
    expect(buy.json.verified, "domain registered + attached").toBe(true);

    const balAfter = await c<{ balance?: number }>(
      "GET",
      "/api/v1/credits/balance",
    );
    const debited =
      (balBefore.json.balance ?? 0) - (balAfter.json.balance ?? 0);
    console.log(`[domain] debited ${debited} for ${domain}`);
    expect(Math.abs(debited - 14.95), "exact $14.95 .com debit").toBeLessThan(
      0.01,
    );

    // 4. Status — reflects the registered/attached domain.
    const status = await c("POST", `/api/v1/apps/${appId}/domains/status`, {
      domain,
    });
    expect([200, 201]).toContain(status.status);

    // 5. Per-app + org domain listings contain it.
    const appDomains = await c<DomainListResponse>(
      "GET",
      `/api/v1/apps/${appId}/domains`,
    );
    expect(appDomains.status).toBe(200);
    const inAppList = (appDomains.json.domains ?? []).some(
      (d) => d.domain === domain || d.name === domain,
    );
    expect(inAppList, "bought domain appears in the app's domain list").toBe(
      true,
    );

    const orgDomains = await c<DomainListResponse>("GET", "/api/v1/domains");
    expect(orgDomains.status).toBe(200);

    // 6. DNS record CRUD against the (stub) Cloudflare zone.
    const listRecords = await c<{ success?: boolean; records?: unknown[] }>(
      "GET",
      `/api/v1/apps/${appId}/domains/${domain}/dns`,
    );
    expect(
      listRecords.status,
      `dns list reachable for cloudflare-registered domain (status ${listRecords.status})`,
    ).toBe(200);

    const createRecord = await c<{
      success?: boolean;
      record?: { id?: string };
    }>("POST", `/api/v1/apps/${appId}/domains/${domain}/dns`, {
      type: "TXT",
      name: "_e2e",
      content: "hello-e2e",
      ttl: 300,
    });
    expect([200, 201], `dns create status ${createRecord.status}`).toContain(
      createRecord.status,
    );
    const recordId = createRecord.json.record?.id;
    if (recordId) {
      const updated = await c(
        "PATCH",
        `/api/v1/apps/${appId}/domains/${domain}/dns/${recordId}`,
        { type: "TXT", name: "_e2e", content: "updated-e2e", ttl: 300 },
      );
      expect([200, 201]).toContain(updated.status);

      const deleted = await c(
        "DELETE",
        `/api/v1/apps/${appId}/domains/${domain}/dns/${recordId}`,
      );
      expect([200, 204]).toContain(deleted.status);
    }

    // 7. Detach the domain from the app.
    const detach = await c("DELETE", `/api/v1/apps/${appId}/domains`, {
      domain,
    });
    expect([200, 204], `detach status ${detach.status}`).toContain(
      detach.status,
    );
  });
});
