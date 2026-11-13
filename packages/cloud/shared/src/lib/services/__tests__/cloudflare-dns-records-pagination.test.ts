/**
 * `GET /zones/:id/dns_records` is a paged Cloudflare endpoint. `listRecords`
 * promises the zone's records, so it must read every page. Reading one page and
 * reporting success loses every record after the first page: the domains DNS
 * view shows a partial zone, and the purchase reconciler cannot find an
 * existing CNAME it should update.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.CLOUDFLARE_API_TOKEN = "test-token";
delete process.env.ELIZA_CF_REGISTRAR_DEV_STUB;

const ZONE_ID = "0123456789abcdef0123456789abcdef";

function page(
  records: Array<{ id: string; name: string }>,
  pageNumber: number,
  perPage: number,
  total: number,
): Response {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: records.map((record) => ({
        id: record.id,
        type: "TXT",
        name: record.name,
        content: `${record.name}-value`,
        ttl: 1,
        proxied: false,
      })),
      result_info: { page: pageNumber, per_page: perPage, total_count: total },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("cloudflareDnsService.listRecords", () => {
  const originalFetch = globalThis.fetch;
  let requested: string[] = [];

  beforeEach(() => {
    requested = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns every page of a zone that spans more than one page", async () => {
    const total = 250;
    const all = Array.from({ length: total }, (_, index) => ({
      id: `record-${index}`,
      name: `host-${index}.example.com`,
    }));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requested.push(`${url.pathname}${url.search}`);
      const perPage = Number(url.searchParams.get("per_page") ?? "100");
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      const start = (pageNumber - 1) * perPage;
      return page(all.slice(start, start + perPage), pageNumber, perPage, total);
    }) as typeof fetch;

    const { cloudflareDnsService } = await import("../cloudflare-dns");
    const records = await cloudflareDnsService.listRecords(ZONE_ID);

    expect(records.length).toBe(total);
    expect(new Set(records.map((record) => record.id)).size).toBe(total);
    expect(records.at(-1)?.name).toBe(`host-${total - 1}.example.com`);
    // Pages one and two are full, so the listing must have asked for page three.
    expect(requested.at(-1)).toContain("page=3");
  });

  test("stops after the short page of a one-page zone", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requested.push(`${url.pathname}${url.search}`);
      return page([{ id: "record-0", name: "host-0.example.com" }], 1, 100, 1);
    }) as typeof fetch;

    const { cloudflareDnsService } = await import("../cloudflare-dns");
    const records = await cloudflareDnsService.listRecords(ZONE_ID);

    expect(records.map((record) => record.id)).toEqual(["record-0"]);
    expect(requested.length).toBe(1);
  });
});
