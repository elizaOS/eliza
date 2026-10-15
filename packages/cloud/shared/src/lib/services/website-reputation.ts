/**
 * Website reputation index: threat list selection, list parsing, the compact
 * hash index in R2, list status and hash-prefix lookup.
 *
 * Results are `listed`, `not_listed` ("No known threat") or `unavailable`.
 * Nothing here can produce a "safe" result. List age never changes a result:
 * the last-good copy of a list always counts, and its dates and hash are
 * provenance only. The on-device list remains the
 * primary check for a browser; this Cloud index only supplements it and must
 * never be awaited before a page opens.
 *
 * Storage (existing `BLOB` R2 binding, no new resource):
 *   website-reputation/v1/manifest.json      current snapshot and list provenance
 *   website-reputation/v1/lists/<id>.txt     last-good validated list body
 *   website-reputation/v1/slots/<a|b>/<xx>.bin
 *     256 shards keyed by the first hash byte. Each shard is a sorted array of
 *     33-byte records: a 32-byte SHA-256 of a listed host, then a bitmask of
 *     manifest list bits. The ingest job writes the inactive slot, then
 *     switches the manifest, so the previous snapshot stays served on failure.
 *
 * List parsing mirrors `parseThreatDomains` in
 * `packages/os/browser/protection/policy.mjs` (the parity test runs both).
 * That module is a private Node/extension `.mjs` file in `@elizaos/os`, so
 * the Worker cannot import it directly.
 */

import {
  hashPrefix,
  normalizeWebsiteHost,
  WEBSITE_REPUTATION_MAX_PREFIX_BYTES,
  WEBSITE_REPUTATION_MIN_PREFIX_BYTES,
  type WebsiteReputationCategory,
  type WebsiteReputationIndexStatus,
  type WebsiteReputationListFreshness,
  type WebsiteReputationLookupResponse,
  type WebsiteReputationMatch,
  type WebsiteReputationVerdict,
  websiteHostHashes,
  websiteReputationVerdict,
} from "@elizaos/cloud-sdk/website-reputation";
import { getRuntimeR2Bucket, type RuntimeR2Bucket } from "../storage/r2-runtime-binding";

export interface WebsiteThreatFeed {
  id: string;
  source: string;
  category: WebsiteReputationCategory;
  url: string;
  /** Phishing.Database: fall back to the GitHub repository at its latest commit. */
  githubMirror?: { repo: string; path: string };
  /** Where the publisher states the publication time. */
  publishedAt: "hagezi-header" | "last-modified";
  license: string;
  licenseUrl: string;
  /**
   * `verified`: the list license permits redistribution and commercial use.
   * `approved`: approved by the owner with counsel (2026-10-15) for this free,
   * open-source lookup; see docs/website-reputation.md.
   */
  reviewState: "verified" | "approved";
  minEntries: number;
  maxBytes: number;
}

const MIB = 1024 * 1024;
const HAGEZI_LICENSE = "https://github.com/hagezi/dns-blocklists/blob/main/LICENSE";
const HAGEZI_BASE = "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard";

/**
 * Threat lists only. HaGeZi ad/tracker lists (multi, pro, ultimate) are
 * deliberately excluded: they flag ordinary sites and are not threat data.
 */
export const WEBSITE_THREAT_FEEDS: readonly WebsiteThreatFeed[] = [
  {
    id: "phishing-database",
    source: "Phishing.Database",
    category: "phishing",
    url: "https://phish.co.za/latest/phishing-domains-ACTIVE.txt",
    githubMirror: {
      repo: "Phishing-Database/Phishing.Database",
      path: "phishing-domains-ACTIVE.txt",
    },
    publishedAt: "last-modified",
    license: "MIT",
    licenseUrl: "https://github.com/Phishing-Database/Phishing.Database/blob/master/LICENSE",
    reviewState: "verified",
    minEntries: 1000,
    maxBytes: 24 * MIB,
  },
  {
    id: "hagezi-tif-medium",
    source: "HaGeZi TIF medium",
    category: "malware_or_scam",
    url: `${HAGEZI_BASE}/tif.medium-onlydomains.txt`,
    publishedAt: "hagezi-header",
    license: "GPL-3.0",
    licenseUrl: HAGEZI_LICENSE,
    reviewState: "approved",
    minEntries: 50_000,
    maxBytes: 24 * MIB,
  },
  {
    id: "hagezi-fake",
    source: "HaGeZi Fake",
    category: "fake_shop_or_scam",
    url: `${HAGEZI_BASE}/fake-onlydomains.txt`,
    publishedAt: "hagezi-header",
    license: "GPL-3.0",
    licenseUrl: HAGEZI_LICENSE,
    reviewState: "approved",
    minEntries: 1000,
    maxBytes: 4 * MIB,
  },
];

export const WEBSITE_REPUTATION_ROOT = "website-reputation/v1";
export const WEBSITE_REPUTATION_MANIFEST_KEY = `${WEBSITE_REPUTATION_ROOT}/manifest.json`;
export const websiteReputationListKey = (id: string) =>
  `${WEBSITE_REPUTATION_ROOT}/lists/${id}.txt`;
export const websiteReputationShardKey = (slot: "a" | "b", shard: number) =>
  `${WEBSITE_REPUTATION_ROOT}/slots/${slot}/${shard.toString(16).padStart(2, "0")}.bin`;

export const RECORD_BYTES = 33;
export const SHARD_COUNT = 256;
/** Same bound as the on-device rule compiler (`MAX_DOMAINS`). */
export const MAX_LIST_ENTRIES = 1_200_000;

export interface WebsiteReputationManifestList {
  id: string;
  source: string;
  category: WebsiteReputationCategory;
  url: string;
  license: string;
  licenseUrl: string;
  reviewState: WebsiteThreatFeed["reviewState"];
  /** `refreshed`: this run validated new or unchanged data. `last-good`: reused an older copy. */
  state: "refreshed" | "last-good" | "unavailable";
  /** Bit in each shard record's mask; null when the list has no data. */
  bit: number | null;
  publishedAt: string | null;
  fetchedAt: string | null;
  sha256: string | null;
  bytes: number | null;
  entries: number | null;
  /** Short reason of the latest failed refresh, when any. */
  error?: string;
}

export interface WebsiteReputationManifest {
  version: 1;
  snapshotId: string;
  slot: "a" | "b";
  generatedAt: string;
  checkedAt: string;
  recordCount: number;
  lists: WebsiteReputationManifestList[];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validates one list body and calls `onHost` for each valid host. The rules
 * match the on-device `parseThreatDomains`: comment and blank lines skipped,
 * hosts lowercased, at least `minEntries` valid hosts and at most 1% invalid
 * lines. It also enforces the entry ceiling and, for HaGeZi, the declared
 * "Number of entries".
 */
export function scanThreatList(
  body: string,
  feed: Pick<WebsiteThreatFeed, "minEntries" | "publishedAt">,
  onHost: (host: string) => void = () => {},
): { entries: number; invalid: number } {
  let entries = 0;
  let invalid = 0;
  let start = 0;
  while (start <= body.length) {
    let end = body.indexOf("\n", start);
    if (end === -1) end = body.length;
    const host = body.slice(start, end).trim().toLowerCase();
    start = end + 1;
    if (!host || host.startsWith("#")) continue;
    if (host.length <= 253 && host.includes(".") && host.split(".").every((l) => LABEL.test(l))) {
      entries++;
      if (entries > MAX_LIST_ENTRIES) throw new Error("threat list exceeds the entry limit");
      onHost(host);
    } else invalid++;
  }
  if (entries < feed.minEntries || invalid > entries / 100) {
    throw new Error("invalid threat list format");
  }
  if (feed.publishedAt === "hagezi-header") {
    const declared = body.match(/^# Number of entries: (\d+)\s*$/m)?.[1];
    if (declared === undefined || Number(declared) !== entries) {
      throw new Error("threat list entry count does not match its header");
    }
  }
  return { entries, invalid };
}

/** Publication time stated in a HaGeZi header (`# Last modified: 15 Oct 2026 08:34 UTC`). */
export function hageziPublishedAt(body: string): number {
  return Date.parse(body.match(/^# Last modified: (.+)$/m)?.[1] ?? "");
}

/** Accumulates 33-byte records into 256 shards, then sorts and merges masks. */
export class ShardBuilder {
  private readonly buffers: Uint8Array[] = [];
  private readonly lengths = new Array<number>(SHARD_COUNT).fill(0);

  constructor(expectedRecords = 0) {
    const initial = Math.max(64, Math.ceil((expectedRecords / SHARD_COUNT) * 1.2)) * RECORD_BYTES;
    for (let i = 0; i < SHARD_COUNT; i++) this.buffers.push(new Uint8Array(initial));
  }

  add(hash: Uint8Array, bit: number): void {
    const shard = hash[0];
    let buffer = this.buffers[shard];
    const length = this.lengths[shard];
    if (length + RECORD_BYTES > buffer.length) {
      const grown = new Uint8Array(buffer.length * 2);
      grown.set(buffer.subarray(0, length));
      this.buffers[shard] = buffer = grown;
    }
    buffer.set(hash.subarray(0, 32), length);
    buffer[length + 32] = 1 << bit;
    this.lengths[shard] = length + RECORD_BYTES;
  }

  /** Sorted, de-duplicated shard; equal hashes from several lists merge their bits. */
  finish(shard: number): Uint8Array {
    const source = this.buffers[shard];
    const count = this.lengths[shard] / RECORD_BYTES;
    const order = Array.from({ length: count }, (_, i) => i);
    order.sort((x, y) => compareRecords(source, x * RECORD_BYTES, source, y * RECORD_BYTES, 32));
    const out = new Uint8Array(count * RECORD_BYTES);
    let written = 0;
    for (const index of order) {
      const offset = index * RECORD_BYTES;
      if (written > 0 && compareRecords(out, written - RECORD_BYTES, source, offset, 32) === 0) {
        out[written - 1] |= source[offset + 32];
        continue;
      }
      out.set(source.subarray(offset, offset + RECORD_BYTES), written);
      written += RECORD_BYTES;
    }
    this.buffers[shard] = new Uint8Array(0);
    return out.subarray(0, written);
  }
}

function compareRecords(
  a: Uint8Array,
  aOffset: number,
  b: Uint8Array,
  bOffset: number,
  length: number,
): number {
  for (let i = 0; i < length; i++) {
    const diff = a[aOffset + i] - b[bOffset + i];
    if (diff !== 0) return diff;
  }
  return 0;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Records in a sorted shard whose hash starts with `prefix` (2 to 4 bytes). */
export function findPrefixInShard(
  shard: Uint8Array,
  prefix: Uint8Array,
): Array<{ hash: string; mask: number }> {
  let low = 0;
  let high = shard.length / RECORD_BYTES;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareRecords(shard, mid * RECORD_BYTES, prefix, 0, prefix.length) < 0) low = mid + 1;
    else high = mid;
  }
  const out: Array<{ hash: string; mask: number }> = [];
  for (let i = low; i < shard.length / RECORD_BYTES; i++) {
    const offset = i * RECORD_BYTES;
    if (compareRecords(shard, offset, prefix, 0, prefix.length) !== 0) break;
    out.push({ hash: toHex(shard.subarray(offset, offset + 32)), mask: shard[offset + 32] });
  }
  return out;
}

export function parsePrefix(prefix: string): Uint8Array | null {
  if (
    typeof prefix !== "string" ||
    !/^[0-9a-f]+$/.test(prefix) ||
    prefix.length % 2 !== 0 ||
    prefix.length < WEBSITE_REPUTATION_MIN_PREFIX_BYTES * 2 ||
    prefix.length > WEBSITE_REPUTATION_MAX_PREFIX_BYTES * 2
  ) {
    return null;
  }
  const bytes = new Uint8Array(prefix.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(prefix.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Per-list status. A list with data is `loaded` at any age; its dates are
 * provenance only and never downgrade a result.
 */
export function websiteReputationFreshness(manifest: WebsiteReputationManifest | null): {
  status: WebsiteReputationIndexStatus;
  lists: WebsiteReputationListFreshness[];
} {
  if (!manifest) return { status: "unavailable", lists: [] };
  const lists = manifest.lists.map((list): WebsiteReputationListFreshness => {
    const status = list.bit === null ? "unavailable" : "loaded";
    return {
      id: list.id,
      source: list.source,
      category: list.category,
      status,
      publishedAt: list.publishedAt,
      fetchedAt: list.fetchedAt,
      sha256: list.sha256,
    };
  });
  const loaded = lists.filter((list) => list.status === "loaded").length;
  const status = loaded === 0 ? "unavailable" : loaded === lists.length ? "complete" : "partial";
  return { status, lists };
}

const MANIFEST_TTL_MS = 60_000;
const SHARD_CACHE_LIMIT = 96;
let manifestCache: { at: number; manifest: WebsiteReputationManifest | null } | null = null;
const shardCache = new Map<string, Uint8Array>();

/** Test hook: drop in-isolate caches. */
export function resetWebsiteReputationCache(): void {
  manifestCache = null;
  shardCache.clear();
}

export async function readWebsiteReputationManifest(
  bucket: RuntimeR2Bucket,
): Promise<WebsiteReputationManifest | null> {
  const object = await bucket.get(WEBSITE_REPUTATION_MANIFEST_KEY);
  if (!object) return null;
  const manifest = JSON.parse(await object.text()) as WebsiteReputationManifest;
  if (manifest?.version !== 1 || !Array.isArray(manifest.lists)) return null;
  return manifest;
}

async function cachedManifest(bucket: RuntimeR2Bucket, now: number, force = false) {
  if (!force && manifestCache && now - manifestCache.at < MANIFEST_TTL_MS) {
    return manifestCache.manifest;
  }
  const manifest = await readWebsiteReputationManifest(bucket);
  manifestCache = { at: now, manifest };
  return manifest;
}

async function readShard(
  bucket: RuntimeR2Bucket,
  manifest: WebsiteReputationManifest,
  shard: number,
): Promise<Uint8Array | null> {
  const cacheKey = `${manifest.snapshotId}/${shard}`;
  const cached = shardCache.get(cacheKey);
  if (cached) return cached;
  const object = await bucket.get(websiteReputationShardKey(manifest.slot, shard));
  if (!object?.arrayBuffer) return null;
  // The slot may have been rewritten by a newer build after this manifest was read.
  if (object.customMetadata?.snapshotId !== manifest.snapshotId) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length % RECORD_BYTES !== 0) return null;
  if (shardCache.size >= SHARD_CACHE_LIMIT) {
    const oldest = shardCache.keys().next().value;
    if (oldest !== undefined) shardCache.delete(oldest);
  }
  shardCache.set(cacheKey, bytes);
  return bytes;
}

const unavailableResponse = (): WebsiteReputationLookupResponse => ({
  status: "unavailable",
  generatedAt: null,
  lists: [],
  matches: [],
});

/**
 * Returns full hashes on loaded lists that start with any requested prefix.
 * The caller supplies validated prefixes; nothing about them is logged.
 */
export async function lookupWebsiteReputationPrefixes(
  prefixes: Uint8Array[],
  options: { bucket?: RuntimeR2Bucket | null; now?: number } = {},
): Promise<WebsiteReputationLookupResponse> {
  const bucket = options.bucket === undefined ? getRuntimeR2Bucket() : options.bucket;
  if (!bucket) return unavailableResponse();
  const now = options.now ?? Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const manifest = await cachedManifest(bucket, now, attempt > 0);
    const freshness = websiteReputationFreshness(manifest);
    if (!manifest || freshness.status === "unavailable") {
      return { ...unavailableResponse(), lists: freshness.lists };
    }
    const loadedBits = new Map<number, string>();
    manifest.lists.forEach((list, index) => {
      if (list.bit !== null && freshness.lists[index].status === "loaded") {
        loadedBits.set(list.bit, list.id);
      }
    });
    const shards = new Map<number, Uint8Array | null>();
    await Promise.all(
      [...new Set(prefixes.map((prefix) => prefix[0]))].map(async (shard) => {
        shards.set(shard, await readShard(bucket, manifest, shard));
      }),
    );
    if ([...shards.values()].some((shard) => shard === null)) continue;
    const matches = new Map<string, WebsiteReputationMatch>();
    for (const prefix of prefixes) {
      for (const record of findPrefixInShard(shards.get(prefix[0]) as Uint8Array, prefix)) {
        const lists = [...loadedBits]
          .filter(([bit]) => record.mask & (1 << bit))
          .map(([, id]) => id);
        if (lists.length) matches.set(record.hash, { hash: record.hash, lists });
      }
    }
    return {
      status: freshness.status,
      generatedAt: manifest.generatedAt,
      lists: freshness.lists,
      matches: [...matches.values()],
    };
  }
  return unavailableResponse();
}

/**
 * Direct server-side check for addresses Cloud already holds (for example web
 * search results). Uses the same normalization, candidates and verdict rules
 * as the client SDK. Failures resolve to `unavailable`.
 */
export async function checkWebsiteReputation(
  addresses: string[],
  options: { bucket?: RuntimeR2Bucket | null; now?: number } = {},
): Promise<WebsiteReputationVerdict[]> {
  const hosts = addresses.map((address) => normalizeWebsiteHost(address));
  const candidates = await Promise.all(
    hosts.map((entry) => ("host" in entry ? websiteHostHashes(entry.host) : Promise.resolve([]))),
  );
  const prefixes = [
    ...new Set(candidates.flat().map((candidate) => hashPrefix(candidate.hash))),
  ].map((prefix) => parsePrefix(prefix) as Uint8Array);
  let response: WebsiteReputationLookupResponse;
  try {
    response = prefixes.length
      ? await lookupWebsiteReputationPrefixes(prefixes, options)
      : unavailableResponse();
  } catch {
    response = unavailableResponse();
  }
  return hosts.map((entry, index) =>
    "host" in entry
      ? websiteReputationVerdict(entry.host, candidates[index], response)
      : { status: "unavailable", host: null, reason: entry.reason },
  );
}
