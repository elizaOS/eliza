import { expect, test } from "bun:test";
import {
  createWebsiteReputationClient,
  hashPrefix,
  normalizeWebsiteHost,
  sha256Hex,
  type WebsiteReputationLookupResponse,
  websiteHostCandidates,
  websiteHostHashes,
  websiteReputationVerdict,
} from "./website-reputation.js";

const list = (status: "loaded" | "unavailable", id = "phishing-database") => ({
  id,
  source:
    id === "phishing-database" ? "Phishing.Database" : "HaGeZi TIF medium",
  category:
    id === "phishing-database"
      ? ("phishing" as const)
      : ("malware_or_scam" as const),
  status,
  publishedAt: null,
  fetchedAt: null,
  sha256: null,
});

test("normalizes addresses like the on-device lookup", () => {
  expect(normalizeWebsiteHost("https://Login.Example.COM./path?q=1")).toEqual({
    host: "login.example.com",
  });
  expect(normalizeWebsiteHost("example.org")).toEqual({ host: "example.org" });
  expect(normalizeWebsiteHost("https://pаypal.com/")).toEqual({
    host: "xn--pypal-4ve.com",
  });
  expect(normalizeWebsiteHost("http://192.168.0.1/")).toEqual({
    reason: "local-address",
  });
  expect(normalizeWebsiteHost("https://[::1]/")).toEqual({
    reason: "local-address",
  });
  expect(normalizeWebsiteHost("https://localhost/")).toEqual({
    reason: "local-address",
  });
  expect(normalizeWebsiteHost("https://user:pw@example.com/")).toEqual({
    reason: "invalid-address",
  });
  expect(normalizeWebsiteHost("ftp://example.com/")).toEqual({
    reason: "invalid-address",
  });
  expect(normalizeWebsiteHost("")).toEqual({ reason: "invalid-address" });
});

test("candidates cover the host and parent domains down to two labels", () => {
  expect(websiteHostCandidates("a.b.example.co.uk")).toEqual([
    "a.b.example.co.uk",
    "b.example.co.uk",
    "example.co.uk",
    "co.uk",
  ]);
  const deep = websiteHostCandidates("1.2.3.4.5.6.7.8.example.com");
  expect(deep[0]).toBe("1.2.3.4.5.6.7.8.example.com");
  expect(deep).toContain("example.com");
  expect(deep).toHaveLength(6);
});

test("sha256Hex matches the reference digest", async () => {
  expect(await sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("a hit on a loaded list is listed, even when another list is unavailable", async () => {
  const candidates = await websiteHostHashes("login.evil.example");
  const parent = candidates.find((c) => c.host === "evil.example");
  const verdict = websiteReputationVerdict("login.evil.example", candidates, {
    status: "partial",
    lists: [list("loaded"), list("unavailable", "hagezi-tif-medium")],
    matches: [{ hash: parent?.hash ?? "", lists: ["phishing-database"] }],
  });
  expect(verdict).toMatchObject({
    status: "listed",
    matchedHost: "evil.example",
    sources: ["Phishing.Database"],
  });
  if (verdict.status === "listed") {
    expect(verdict.warning).toBe(
      "Known harmful site (Phishing.Database; phishing): do not open or enter information.",
    );
  }
});

test("no hit is never safe: one loaded list gives not_listed, none gives unavailable", async () => {
  const candidates = await websiteHostHashes("example.com");
  const prefixOnly = {
    hash: `${hashPrefix(candidates[0].hash)}${"0".repeat(56)}`,
    lists: ["phishing-database"],
  };
  const base = { lists: [list("loaded")], matches: [prefixOnly] };
  for (const status of ["complete", "partial"] as const) {
    const verdict = websiteReputationVerdict("example.com", candidates, {
      ...base,
      status,
    });
    expect(verdict).toEqual({
      status: "not_listed",
      host: "example.com",
      label: "No known threat",
    });
    expect(JSON.stringify(verdict).toLowerCase()).not.toContain("safe");
  }
  expect(
    websiteReputationVerdict("example.com", candidates, {
      status: "unavailable",
      lists: [],
      matches: [],
    }),
  ).toEqual({
    status: "unavailable",
    host: "example.com",
    reason: "unavailable",
  });
});

test("a match on an unavailable list does not count", async () => {
  const candidates = await websiteHostHashes("evil.example");
  expect(
    websiteReputationVerdict("evil.example", candidates, {
      status: "partial",
      lists: [list("loaded"), list("unavailable", "hagezi-tif-medium")],
      matches: [{ hash: candidates[0].hash, lists: ["hagezi-tif-medium"] }],
    }),
  ).toMatchObject({ status: "not_listed" });
});

test("the client sends only hash prefixes and fails to unavailable", async () => {
  const bodies: string[] = [];
  const candidates = await websiteHostHashes("login.evil.example");
  const response: WebsiteReputationLookupResponse = {
    status: "complete",
    generatedAt: "2026-10-15T00:00:00.000Z",
    lists: [list("loaded")],
    matches: [{ hash: candidates[1].hash, lists: ["phishing-database"] }],
  };
  const client = createWebsiteReputationClient({
    baseUrl: "https://cloud.test",
    apiKey: "test-key",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Response.json(response);
    }) as unknown as typeof fetch,
  });
  expect(
    await client.check("https://login.evil.example/account"),
  ).toMatchObject({
    status: "listed",
  });
  const sent = JSON.parse(bodies[0]);
  expect(Object.keys(sent)).toEqual(["prefixes"]);
  expect(sent.prefixes.every((p: string) => /^[0-9a-f]{8}$/.test(p))).toBe(
    true,
  );
  expect(bodies[0]).not.toContain("evil");
  for (const candidate of candidates)
    expect(bodies[0]).not.toContain(candidate.hash);

  const failing = createWebsiteReputationClient({
    baseUrl: "https://cloud.test",
    apiKey: "test-key",
    fetchImpl: (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch,
  });
  expect(await failing.check("https://example.com")).toMatchObject({
    status: "unavailable",
  });
  const erroring = createWebsiteReputationClient({
    baseUrl: "https://cloud.test",
    apiKey: "test-key",
    fetchImpl: (async () =>
      new Response("no", { status: 503 })) as unknown as typeof fetch,
  });
  expect(await erroring.check("https://example.com")).toMatchObject({
    status: "unavailable",
  });
});
