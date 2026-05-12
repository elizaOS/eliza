import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const ORIGINAL_STUB = process.env.ELIZA_CF_REGISTRAR_DEV_STUB;

beforeAll(() => {
  process.env.ELIZA_CF_REGISTRAR_DEV_STUB = "1";
});

afterAll(() => {
  if (ORIGINAL_STUB === undefined) delete process.env.ELIZA_CF_REGISTRAR_DEV_STUB;
  else process.env.ELIZA_CF_REGISTRAR_DEV_STUB = ORIGINAL_STUB;
});

async function importDns() {
  const mod = await import(`../../../lib/services/cloudflare-dns.ts?stub=${Date.now()}`);
  return mod.cloudflareDnsService;
}

describe("cloudflare-dns stub", () => {
  test("createRecord returns a stubbed DnsRecord shape", async () => {
    const dns = await importDns();
    const rec = await dns.createRecord("zone-1", {
      type: "CNAME",
      name: "app.nubilio.org",
      content: "container-host.elizacloud.ai",
    });
    expect(rec.id).toMatch(/^stub-record-/);
    expect(rec.type).toBe("CNAME");
    expect(rec.name).toBe("app.nubilio.org");
    expect(rec.content).toBe("container-host.elizacloud.ai");
    expect(rec.ttl).toBe(1);
    expect(rec.proxied).toBe(false);
  });

  test("createRecord respects ttl + proxied overrides", async () => {
    const dns = await importDns();
    const rec = await dns.createRecord("zone-1", {
      type: "A",
      name: "@",
      content: "10.0.0.1",
      ttl: 300,
      proxied: true,
    });
    expect(rec.ttl).toBe(300);
    expect(rec.proxied).toBe(true);
  });

  test("listRecords returns an empty array in stub mode", async () => {
    const dns = await importDns();
    const recs = await dns.listRecords("zone-1");
    expect(Array.isArray(recs)).toBe(true);
    expect(recs.length).toBe(0);
  });

  test("getRecord returns a deterministic stub for the requested id", async () => {
    const dns = await importDns();
    const rec = await dns.getRecord("zone-1", "rec-123");
    expect(rec.id).toBe("rec-123");
    expect(rec.type).toBeDefined();
  });

  test("updateRecord echoes back the patch + preserves the requested id", async () => {
    const dns = await importDns();
    const updated = await dns.updateRecord("zone-1", "rec-123", {
      content: "10.0.0.99",
      ttl: 60,
    });
    expect(updated.id).toBe("rec-123");
    expect(updated.content).toBe("10.0.0.99");
    expect(updated.ttl).toBe(60);
  });

  test("deleteRecord resolves cleanly without throwing", async () => {
    const dns = await importDns();
    await expect(dns.deleteRecord("zone-1", "rec-123")).resolves.toBeUndefined();
  });
});
