import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PHISHING_COMMIT_FEED,
  parseLatestCommitFeed,
} from "../protection/policy.mjs";
import { createWebsiteReputation as create } from "../protection/reputation.mjs";

const PHISHING_FEED = "https://phish.co.za/latest/phishing-domains-ACTIVE.txt";
const THREAT_FEED =
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/tif.mini-onlydomains.txt";
const REPUTATION_FEEDS = [
  {
    id: "phishing",
    mirror: true,
    url: PHISHING_FEED,
    source: "Phishing.Database",
    license: "MIT",
    licenseUrl:
      "https://github.com/Phishing-Database/Phishing.Database/blob/master/LICENSE",
    threats: ["SOCIAL_ENGINEERING"],
  },
  {
    id: "threats",
    url: THREAT_FEED,
    source: "HaGeZi TIF Mini",
    license: "GPL-3.0",
    licenseUrl: "https://github.com/hagezi/dns-blocklists/blob/main/LICENSE",
    threats: ["MALWARE_OR_SCAM"],
  },
];
const createWebsiteReputation = (options) =>
  create({
    cacheDir: null,
    feeds: [{ ...REPUTATION_FEEDS[0], mirror: false }],
    ...options,
  });
const start = Date.parse("2026-10-02T12:00:00Z");
const feed = (text = "bad.example\nphishing.example\n", date = start) =>
  new Response(text, {
    headers: { "last-modified": new Date(date).toUTCString() },
  });
test("free local matching protects subdomains without sending addresses or secrets", async () => {
  let calls = 0,
    time = start;
  const check = createWebsiteReputation({
    minEntries: 2,
    now: () => time,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, PHISHING_FEED);
      assert.equal(options.headers, undefined);
      return feed();
    },
  });
  const replies = await Promise.all(
    [
      "https://bad.example/reset/private?token=secret",
      "https://sub.bad.example",
      "https://notbad.example",
    ].map(check),
  );
  assert.deepEqual(
    replies.map((v) => v.status),
    ["blocked", "blocked", "no-known-threat"],
  );
  assert.equal(calls, 1);
  time += 7 * 3600000;
  await check.warmup();
  await check("https://example.org");
  assert.equal(calls, 2);
  for (const url of [
    "https://u:p@example.org",
    "http://example.org",
    "https://127.0.0.1/",
  ])
    assert.equal((await check(url)).status, "unavailable");
  assert.equal(calls, 2);
});
test("unavailable, empty and malformed feeds never produce a clean verdict", async () => {
  for (const response of [
    () => new Response("error", { status: 503 }),
    () => feed("", start),
    () => feed("<html>oops</html>"),
    () => new Response("bad.example"),
  ]) {
    const check = createWebsiteReputation({
      minEntries: 2,
      now: () => start,
      fetchImpl: async () => response(),
    });
    assert.equal((await check("https://example.org")).status, "unavailable");
  }
});
test("verdicts have exactly the shapes declared in reputation.d.mts", async () => {
  const check = createWebsiteReputation({
    minEntries: 2,
    now: () => start,
    fetchImpl: async () => feed(),
  });
  assert.deepEqual(await check("https://sub.bad.example/path"), {
    status: "blocked",
    source: "Phishing.Database",
    scope: "domain",
    threats: ["SOCIAL_ENGINEERING"],
  });
  assert.deepEqual(await check("https://example.org"), {
    status: "no-known-threat",
    source: "Phishing.Database",
    scope: "domain",
  });
  assert.deepEqual(await check("http://example.org"), {
    status: "unavailable",
    reason: "invalid-address",
  });
  assert.deepEqual(await check("https://localhost/"), {
    status: "unavailable",
    reason: "local-address",
  });
  const offline = createWebsiteReputation({
    now: () => start,
    fetchImpl: async () => new Response("error", { status: 503 }),
  });
  assert.deepEqual(await offline("https://example.org"), {
    status: "unavailable",
    reason: "feed-unavailable",
  });
});
test("old feeds and a failed refresh keep the last-good snapshot at any age; failures have a retry cooldown", async () => {
  // A feed published 13 days ago, or with no date, is used like a new one.
  for (const response of [
    () => feed(undefined, start - 13 * 24 * 3600000),
    () => new Response("bad.example\nphishing.example\n"),
  ]) {
    const old = createWebsiteReputation({
      minEntries: 2,
      now: () => start,
      fetchImpl: async () => response(),
    });
    assert.equal((await old("https://bad.example")).status, "blocked");
    assert.equal((await old("https://example.org")).status, "no-known-threat");
  }

  let time = start,
    calls = 0;
  const check = createWebsiteReputation({
    minEntries: 2,
    now: () => time,
    fetchImpl: async () => {
      if (calls++) throw Error("offline");
      return feed();
    },
  });
  assert.equal((await check("https://bad.example")).status, "blocked");
  time += 7 * 3600000;
  assert.equal((await check("https://bad.example")).status, "blocked");
  await check.warmup();
  await check("https://example.org");
  assert.equal(calls, 2);
  time += 365 * 24 * 3600000;
  assert.equal((await check("https://bad.example")).status, "blocked");
  assert.equal((await check("https://example.org")).status, "no-known-threat");
});
test("disk cache survives offline restart at any age and rejects corrupt bytes and source substitution", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "reputation-"));
  try {
    const check = createWebsiteReputation({
      cacheDir: directory,
      minEntries: 2,
      now: () => start,
      fetchImpl: async () => feed(),
    });
    assert.equal((await check("https://bad.example")).status, "blocked");
    const offline = () =>
      createWebsiteReputation({
        cacheDir: directory,
        minEntries: 2,
        now: () => start,
        fetchImpl: async () => {
          throw Error("offline");
        },
      });
    assert.equal((await offline()("https://bad.example")).status, "blocked");
    assert.equal(
      (await offline()("https://example.org")).status,
      "no-known-threat",
    );
    const old = createWebsiteReputation({
      cacheDir: directory,
      minEntries: 2,
      now: () => start + 365 * 24 * 3600000,
      fetchImpl: async () => {
        throw Error("offline");
      },
    });
    assert.equal((await old("https://bad.example")).status, "blocked");
    assert.equal((await old("https://example.org")).status, "no-known-threat");
    const file = join(directory, "phishing.json"),
      original = JSON.parse(await readFile(file, "utf8"));
    for (const change of [
      { body: "altered.example\n" },
      { url: "https://attacker.example/list" },
      { downloadedAt: start + 3600000 },
      { version: 99 },
    ]) {
      await writeFile(file, JSON.stringify({ ...original, ...change }));
      assert.equal(
        (await offline()("https://example.org")).status,
        "unavailable",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("a current cache serves immediately while refresh runs in the background", async () => {
  let time = start,
    release;
  const check = createWebsiteReputation({
    minEntries: 2,
    now: () => time,
    fetchImpl: async () =>
      time === start
        ? feed()
        : new Promise((resolve) => {
            release = resolve;
          }),
  });
  await check("https://example.org");
  time += 7 * 3600000;
  assert.equal((await check("https://bad.example")).status, "blocked");
  assert.equal(typeof release, "function");
  release(feed());
  await check.warmup();
});
test("one loaded feed is enough for a clean result; a threat from any loaded feed blocks", async () => {
  const check = create({
    feeds: REPUTATION_FEEDS,
    cacheDir: null,
    minEntries: 2,
    now: () => start,
    fetchImpl: async (url) =>
      url === PHISHING_FEED
        ? new Response("", { status: 503 })
        : feed(
            "# Last modified: 02 Oct 2026 12:00 UTC\nmalware.example\nscam.example\n",
          ),
  });
  const verdict = await check("https://malware.example");
  assert.equal(verdict.status, "blocked");
  assert.equal(verdict.source, "HaGeZi TIF Mini");
  const clean = await check("https://example.org");
  assert.equal(clean.status, "no-known-threat");
  assert.equal(clean.source, "HaGeZi TIF Mini");
});
test("primary outage uses immutable official mirror bytes; an old commit is accepted", async () => {
  const urls = [],
    sha = "a".repeat(40);
  const check = create({
    cacheDir: null,
    minEntries: 2,
    feeds: [REPUTATION_FEEDS[0]],
    now: () => start,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url === PHISHING_FEED) return new Response("", { status: 403 });
      assert.ok(!url.startsWith("https://api.github.com/"));
      if (url === PHISHING_COMMIT_FEED)
        return new Response(
          `<?xml version="1.0"?><feed><updated>2020-01-01T00:00:00Z</updated><entry><id>tag:github.com,2008:Grit::Commit/${sha}</id><updated>${new Date(
            start - 13 * 24 * 3600000,
          ).toISOString()}</updated></entry></feed>`,
        );
      assert.equal(
        url,
        `https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/${sha}/phishing-domains-ACTIVE.txt`,
      );
      return feed();
    },
  });
  assert.equal(
    (await check("https://bad.example/secret?token=private")).status,
    "blocked",
  );
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => !url.includes("private")));
});

test("feed policy must be explicit and cache filenames cannot traverse the host directory", () => {
  for (const feeds of [
    undefined,
    [],
    [{ id: "../escape" }],
    [REPUTATION_FEEDS[0], REPUTATION_FEEDS[0]],
  ])
    assert.throws(() => create({ feeds }), /configuration/);
});

test("local-only checks return during a stalled feed download and use the result after refresh", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  let finish;
  const requested = new Promise((resolve) => {
    finish = resolve;
  });
  const server = createServer((_request, response) => finish(response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/feed`;
  const check = createWebsiteReputation({
    feeds: [{ ...REPUTATION_FEEDS[0], url, mirror: false }],
    waitForRefresh: false,
    minEntries: 2,
    now: () => start,
  });
  try {
    const verdict = await Promise.race([
      check("https://bad.example"),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error("lookup waited for the feed")),
          1000,
        ).unref(),
      ),
    ]);
    assert.equal(verdict.status, "unavailable");
    const response = await requested;
    response.writeHead(200, { "last-modified": new Date(start).toUTCString() });
    response.end("bad.example\nphishing.example\n");
    await check.warmup();
    assert.equal((await check("https://bad.example")).status, "blocked");
    assert.equal(
      (await check("https://notbad.example")).status,
      "no-known-threat",
    );
  } finally {
    check.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the commit feed parser reads only the latest entry and rejects feeds without a commit", () => {
  const sha = "b".repeat(40);
  assert.deepEqual(
    parseLatestCommitFeed(
      `<feed><updated>2020-01-01T00:00:00Z</updated><entry><id>tag:github.com,2008:Grit::Commit/${sha}</id><updated>2026-10-02T15:30:28Z</updated></entry><entry><id>tag:github.com,2008:Grit::Commit/${"c".repeat(40)}</id></entry></feed>`,
    ),
    { sha, publishedAt: Date.parse("2026-10-02T15:30:28Z") },
  );
  const undated = parseLatestCommitFeed(
    `<feed><entry><id>tag:github.com,2008:Grit::Commit/${sha}</id></entry></feed>`,
  );
  assert.equal(undated.sha, sha);
  assert.ok(Number.isNaN(undated.publishedAt));
  for (const atom of [
    "",
    "<html>rate limited</html>",
    "<feed><entry><id>tag:github.com,2008:Grit::Commit/short</id></entry></feed>",
  ])
    assert.equal(parseLatestCommitFeed(atom), null);
});
