/** Ingestion bounds, last-good handling, hash-prefix lookup and freshness for the website reputation index. */
import { beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
// The on-device parser this module mirrors. Kept in a test so the two cannot drift.
import { parseThreatDomains } from "../../../../../os/browser/protection/policy.mjs";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import {
  checkWebsiteReputation,
  findPrefixInShard,
  lookupWebsiteReputationPrefixes,
  parsePrefix,
  readWebsiteReputationManifest,
  resetWebsiteReputationCache,
  ShardBuilder,
  scanThreatList,
  type WebsiteThreatFeed,
  websiteReputationShardKey,
} from "./website-reputation";
import { readBoundedText, refreshWebsiteReputationIndex } from "./website-reputation-ingest";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-15T12:00:00Z");

function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  let puts = 0;
  const bucket: RuntimeR2Bucket = {
    async head(key) {
      const object = objects.get(key);
      return object
        ? { size: object.bytes.length, etag: key, customMetadata: object.customMetadata }
        : null;
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        customMetadata: object.customMetadata,
        text: async () => new TextDecoder().decode(object.bytes),
        arrayBuffer: async () => object.bytes.slice().buffer,
      };
    },
    async put(key, value, options) {
      puts++;
      const bytes =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : new Uint8Array((value as Uint8Array).slice());
      objects.set(key, { bytes, customMetadata: options?.customMetadata ?? {} });
      return null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return { bucket, objects, puts: () => puts };
}

const hageziFeed: WebsiteThreatFeed = {
  id: "hagezi-tif-medium",
  source: "HaGeZi TIF medium",
  category: "malware_or_scam",
  url: "https://lists.test/tif.medium-onlydomains.txt",
  publishedAt: "hagezi-header",
  license: "GPL-3.0",
  licenseUrl: "https://github.com/hagezi/dns-blocklists/blob/main/LICENSE",
  reviewState: "approved",
  minEntries: 3,
  maxBytes: 64 * 1024,
};
const phishingFeed: WebsiteThreatFeed = {
  id: "phishing-database",
  source: "Phishing.Database",
  category: "phishing",
  url: "https://lists.test/phishing-domains-ACTIVE.txt",
  githubMirror: {
    repo: "Phishing-Database/Phishing.Database",
    path: "phishing-domains-ACTIVE.txt",
  },
  publishedAt: "last-modified",
  license: "MIT",
  licenseUrl: "https://github.com/Phishing-Database/Phishing.Database/blob/master/LICENSE",
  reviewState: "verified",
  minEntries: 3,
  maxBytes: 64 * 1024,
};

const hageziBody = (hosts: string[], modified = "15 Oct 2026 08:34 UTC") =>
  [
    "# Title: HaGeZi's Threat Intelligence Feeds - medium version",
    `# Last modified: ${modified}`,
    `# Number of entries: ${hosts.length}`,
    "#",
    ...hosts,
    "",
  ].join("\n");

type Served = Record<string, { body: string; headers?: Record<string, string>; status?: number }>;
const fetchFrom = (served: Served) =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    const entry = served[url];
    if (!entry) return new Response("not found", { status: 404 });
    return new Response(entry.body, { status: entry.status ?? 200, headers: entry.headers });
  }) as unknown as typeof fetch;

const tifHosts = ["evil-malware.example", "scam-shop.test", "bad.example.net", "x.co.uk"];
const phishHosts = ["paypa1-login.example", "evil-malware.example", "secure-bank-verify.test"];
const servedLists = (overrides: Served = {}): Served => ({
  [hageziFeed.url]: { body: hageziBody(tifHosts) },
  [phishingFeed.url]: {
    body: `${phishHosts.join("\n")}\n`,
    headers: { "last-modified": new Date(NOW - HOUR).toUTCString() },
  },
  ...overrides,
});

beforeEach(() => resetWebsiteReputationCache());

test("list parsing accepts and rejects exactly what the on-device parser does", () => {
  const cases = [
    "a.example\nB.Example.ORG\n# comment\n\nc.example.net\n",
    "a.example\nb.example\nnot a host\n",
    "a.example\nb.example\n",
    "a.example\n-bad-.example\nb.example\nc.example\n",
    `${Array.from({ length: 200 }, (_, i) => `host${i}.example`).join("\n")}\nbad_host\n`,
    `${Array.from({ length: 200 }, (_, i) => `host${i}.example`).join("\r\n")}\nbad_host\nalso bad\n300.example..\n`,
  ];
  for (const body of cases) {
    let device: string[] | null;
    try {
      device = [...parseThreatDomains(body, 3)].sort();
    } catch {
      device = null;
    }
    let cloud: string[] | null = [];
    try {
      const hosts: string[] = [];
      scanThreatList(body, { minEntries: 3, publishedAt: "last-modified" }, (h) => hosts.push(h));
      cloud = [...new Set(hosts)].sort();
    } catch {
      cloud = null;
    }
    expect(cloud).toEqual(device);
  }
});

test("HaGeZi lists must match their declared entry count", () => {
  expect(scanThreatList(hageziBody(tifHosts), hageziFeed).entries).toBe(4);
  const wrong = hageziBody(tifHosts).replace("# Number of entries: 4", "# Number of entries: 9");
  expect(() => scanThreatList(wrong, hageziFeed)).toThrow("entry count");
  const missing = hageziBody(tifHosts).replace(/^# Number of entries: .*$/m, "");
  expect(() => scanThreatList(missing, hageziFeed)).toThrow("entry count");
});

test("downloads are size-bounded while streaming", async () => {
  const big = new Response("x".repeat(2048));
  await expect(readBoundedText(big, 1024)).rejects.toThrow("too large");
  const declared = new Response("small", { headers: { "content-length": "999999" } });
  await expect(readBoundedText(declared, 1024)).rejects.toThrow("too large");
  await expect(readBoundedText(new Response("ok", { status: 500 }), 1024)).rejects.toThrow();
});

test("shard records sort, merge list bits and answer prefix searches", () => {
  const builder = new ShardBuilder(4);
  const hash = (host: string) => createHash("sha256").update(host).digest();
  builder.add(hash("evil.example"), 0);
  builder.add(hash("evil.example"), 2);
  builder.add(hash("other.example"), 1);
  const target = hash("evil.example");
  const shard = builder.finish(target[0]);
  const found = findPrefixInShard(shard, target.subarray(0, 4));
  expect(found).toEqual([{ hash: target.toString("hex"), mask: 0b101 }]);
  expect(findPrefixInShard(shard, Uint8Array.from([target[0], 0, 0, 0]))).toEqual(
    target[1] === 0 && target[2] === 0 && target[3] === 0 ? found : [],
  );
  expect(parsePrefix("a1b2c3d4")).toEqual(Uint8Array.from([0xa1, 0xb2, 0xc3, 0xd4]));
  for (const bad of ["a1", "a1b2c3d4e5", "A1B2", "zzzz", "abc"])
    expect(parsePrefix(bad)).toBeNull();
});

test("ingestion builds the index; lookups return full hashes for prefixes only", async () => {
  const { bucket } = memoryBucket();
  const summary = await refreshWebsiteReputationIndex({
    bucket,
    fetchImpl: fetchFrom(servedLists()),
    now: () => NOW,
    feeds: [phishingFeed, hageziFeed],
  });
  expect(summary.rebuilt).toBe(true);
  // evil-malware.example is on both lists and merges into one record.
  expect(summary.recordCount).toBe(6);
  const manifest = await readWebsiteReputationManifest(bucket);
  expect(manifest?.lists.map((l) => [l.id, l.state, l.license, l.reviewState])).toEqual([
    ["phishing-database", "refreshed", "MIT", "verified"],
    ["hagezi-tif-medium", "refreshed", "GPL-3.0", "approved"],
  ]);
  expect(manifest?.lists[1].publishedAt).toBe("2026-10-15T08:34:00.000Z");
  expect(manifest?.lists[1].sha256).toBe(
    createHash("sha256").update(hageziBody(tifHosts)).digest("hex"),
  );

  const full = createHash("sha256").update("evil-malware.example").digest();
  const response = await lookupWebsiteReputationPrefixes([full.subarray(0, 4)], {
    bucket,
    now: NOW,
  });
  expect(response.status).toBe("complete");
  expect(response.matches).toEqual([
    { hash: full.toString("hex"), lists: ["phishing-database", "hagezi-tif-medium"] },
  ]);

  const verdicts = await checkWebsiteReputation(
    ["https://login.scam-shop.test/pay", "https://example.com/", "http://10.0.0.1/"],
    { bucket, now: NOW },
  );
  expect(verdicts[0]).toMatchObject({
    status: "listed",
    matchedHost: "scam-shop.test",
    sources: ["HaGeZi TIF medium"],
    categories: ["malware_or_scam"],
  });
  expect(verdicts[1]).toEqual({
    status: "not_listed",
    host: "example.com",
    label: "No known threat",
  });
  expect(verdicts[2]).toMatchObject({ status: "unavailable", reason: "local-address" });
  expect(JSON.stringify(verdicts).toLowerCase()).not.toContain("safe");
});

test("unchanged lists skip the rebuild; a failed list keeps its last-good data", async () => {
  const store = memoryBucket();
  const options = { bucket: store.bucket, now: () => NOW, feeds: [phishingFeed, hageziFeed] };
  const first = await refreshWebsiteReputationIndex({
    ...options,
    fetchImpl: fetchFrom(servedLists()),
  });
  const putsAfterFirst = store.puts();
  const second = await refreshWebsiteReputationIndex({
    ...options,
    fetchImpl: fetchFrom(servedLists()),
  });
  expect(second).toMatchObject({ rebuilt: false, snapshotId: first.snapshotId });
  expect(store.puts() - putsAfterFirst).toBe(1); // manifest only

  // HaGeZi now serves a malformed list and the phishing mirror is down entirely.
  const broken = await refreshWebsiteReputationIndex({
    ...options,
    fetchImpl: fetchFrom({
      [hageziFeed.url]: { body: "<html>error</html>" },
    }),
  });
  expect(broken.rebuilt).toBe(false);
  expect(broken.lists.map((l) => l.state)).toEqual(["last-good", "last-good"]);
  expect(broken.lists[1].error).toBeTruthy();
  const verdicts = await checkWebsiteReputation(["https://scam-shop.test/"], {
    bucket: store.bucket,
    now: NOW,
  });
  expect(verdicts[0].status).toBe("listed");
});

test("a run with no usable list keeps the previous snapshot", async () => {
  const store = memoryBucket();
  await expect(
    refreshWebsiteReputationIndex({
      bucket: store.bucket,
      now: () => NOW,
      feeds: [hageziFeed],
      fetchImpl: fetchFrom({}),
    }),
  ).rejects.toThrow("no website threat list");
  expect(await readWebsiteReputationManifest(store.bucket)).toBeNull();
  expect(
    await checkWebsiteReputation(["https://example.com/"], { bucket: store.bucket, now: NOW }),
  ).toEqual([{ status: "unavailable", host: "example.com", reason: "unavailable" }]);
});

test("list age never downgrades a result: old lists are used and recorded", async () => {
  const store = memoryBucket();
  const old = await refreshWebsiteReputationIndex({
    bucket: store.bucket,
    now: () => NOW,
    feeds: [phishingFeed, hageziFeed],
    fetchImpl: fetchFrom(
      servedLists({
        [hageziFeed.url]: { body: hageziBody(tifHosts, "10 Jan 2026 08:00 UTC") },
        [phishingFeed.url]: { body: `${phishHosts.join("\n")}\n` },
      }),
    ),
  });
  expect(old.lists.map((l) => l.state)).toEqual(["refreshed", "refreshed"]);
  const manifest = await readWebsiteReputationManifest(store.bucket);
  // Provenance is kept even when the publisher gives no date.
  expect(manifest?.lists.map((l) => l.publishedAt)).toEqual([null, "2026-01-10T08:00:00.000Z"]);
  expect(manifest?.lists.every((l) => /^[0-9a-f]{64}$/.test(l.sha256 ?? ""))).toBe(true);

  // A year later, without a refresh, the same results.
  for (const now of [NOW, NOW + 365 * 24 * HOUR]) {
    resetWebsiteReputationCache();
    const verdicts = await checkWebsiteReputation(
      ["https://login.scam-shop.test/", "https://paypa1-login.example/", "https://example.com/"],
      { bucket: store.bucket, now },
    );
    expect(verdicts.map((v) => v.status)).toEqual(["listed", "listed", "not_listed"]);
  }
});

test("one loaded list is enough for not_listed; a never-loaded list adds no matches", async () => {
  const store = memoryBucket();
  const summary = await refreshWebsiteReputationIndex({
    bucket: store.bucket,
    now: () => NOW,
    feeds: [phishingFeed, hageziFeed],
    fetchImpl: fetchFrom({ [hageziFeed.url]: { body: hageziBody(tifHosts) } }),
  });
  expect(summary.lists.map((l) => l.state)).toEqual(["unavailable", "refreshed"]);
  const prefix = createHash("sha256").update("scam-shop.test").digest().subarray(0, 4);
  const response = await lookupWebsiteReputationPrefixes([prefix], {
    bucket: store.bucket,
    now: NOW,
  });
  expect(response.status).toBe("partial");
  expect(response.lists.map((l) => l.status)).toEqual(["unavailable", "loaded"]);
  const verdicts = await checkWebsiteReputation(
    ["https://scam-shop.test/", "https://paypa1-login.example/", "https://example.com/"],
    { bucket: store.bucket, now: NOW },
  );
  // paypa1-login.example is only on the list that never loaded.
  expect(verdicts.map((v) => v.status)).toEqual(["listed", "not_listed", "not_listed"]);
});

test("Phishing.Database falls back to the GitHub repository at its latest commit", async () => {
  const store = memoryBucket();
  const sha = "a".repeat(40);
  const summary = await refreshWebsiteReputationIndex({
    bucket: store.bucket,
    now: () => NOW,
    feeds: [phishingFeed],
    fetchImpl: fetchFrom({
      [phishingFeed.url]: { body: "Forbidden", status: 403 },
      "https://github.com/Phishing-Database/Phishing.Database/commits/master/phishing-domains-ACTIVE.txt.atom":
        {
          body: `<?xml version="1.0"?><feed><updated>2020-01-01T00:00:00Z</updated><entry><id>tag:github.com,2008:Grit::Commit/${sha}</id><updated>2026-10-02T15:30:28Z</updated></entry></feed>`,
        },
      [`https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/${sha}/phishing-domains-ACTIVE.txt`]:
        { body: `${phishHosts.join("\n")}\n` },
    }),
  });
  // A 13-day-old commit is accepted; its date is provenance only.
  expect(summary.lists[0].state).toBe("refreshed");
  const manifest = await readWebsiteReputationManifest(store.bucket);
  expect(manifest?.lists[0].publishedAt).toBe("2026-10-02T15:30:28.000Z");
});

test("downloads use a redirect mode the Workers runtime accepts and never follow a redirect", async () => {
  // workerd throws on `redirect: "error"`, which failed every list in staging.
  const movedFeed: WebsiteThreatFeed = {
    ...hageziFeed,
    id: "hagezi-fake",
    url: "https://lists.test/fake-onlydomains.txt",
  };
  const served = servedLists({
    [movedFeed.url]: { body: "", status: 302, headers: { location: "https://elsewhere.test/" } },
  });
  const modes: Array<RequestRedirect | undefined> = [];
  const workerdFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    modes.push(init?.redirect);
    if (init?.redirect === "error") {
      throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    }
    return fetchFrom(served)(input, init);
  }) as unknown as typeof fetch;
  const store = memoryBucket();
  const summary = await refreshWebsiteReputationIndex({
    bucket: store.bucket,
    now: () => NOW,
    feeds: [hageziFeed, phishingFeed, movedFeed],
    fetchImpl: workerdFetch,
  });
  expect(modes.length).toBeGreaterThan(0);
  expect(modes.every((mode) => mode === "manual")).toBe(true);
  expect(summary.lists.map((list) => list.state)).toEqual([
    "refreshed",
    "refreshed",
    "unavailable",
  ]);
  expect(summary.lists[2].error).toContain("302");
  expect(await readWebsiteReputationManifest(store.bucket)).not.toBeNull();
});

test("a shard rewritten by a newer build is not served under the old manifest", async () => {
  const store = memoryBucket();
  const options = { bucket: store.bucket, now: () => NOW, feeds: [phishingFeed, hageziFeed] };
  await refreshWebsiteReputationIndex({ ...options, fetchImpl: fetchFrom(servedLists()) });
  const manifest = await readWebsiteReputationManifest(store.bucket);
  const full = createHash("sha256").update("scam-shop.test").digest();
  const key = websiteReputationShardKey(manifest?.slot ?? "a", full[0]);
  const shard = store.objects.get(key);
  if (shard) shard.customMetadata = { snapshotId: "other" };
  const response = await lookupWebsiteReputationPrefixes([full.subarray(0, 4)], {
    bucket: store.bucket,
    now: NOW,
  });
  expect(response).toMatchObject({ status: "unavailable", matches: [] });
});
