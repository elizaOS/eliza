/**
 * Scheduled ingestion for the website reputation index.
 *
 * Downloads only the fixed public threat lists in `WEBSITE_THREAT_FEEDS`,
 * validates format and size, records the publication time, fetch time and
 * SHA-256 of each list body as provenance, and builds the compact hash index in R2. A list that fails keeps
 * its last-good body; a run that cannot build anything leaves the previous
 * snapshot in place. Visited addresses are never fetched or stored here.
 */

import { createHash } from "node:crypto";
import { getRuntimeR2Bucket, type RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import {
  hageziPublishedAt,
  RECORD_BYTES,
  readWebsiteReputationManifest,
  SHARD_COUNT,
  ShardBuilder,
  scanThreatList,
  WEBSITE_REPUTATION_MANIFEST_KEY,
  WEBSITE_THREAT_FEEDS,
  type WebsiteReputationManifest,
  type WebsiteReputationManifestList,
  type WebsiteThreatFeed,
  websiteReputationListKey,
  websiteReputationShardKey,
} from "./website-reputation";

const USER_AGENT = "Eliza-Cloud-Website-Reputation";
/**
 * Never follow a redirect. The Workers runtime rejects `redirect: "error"`
 * with a TypeError on every call, so use "manual": a 3xx response is not ok and
 * `readBoundedText` rejects it.
 */
const NO_REDIRECTS = "manual" as const;
const sha256 = (body: string) => createHash("sha256").update(body).digest("hex");
const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** Reads a response body, failing once it exceeds `maxBytes`. */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok || !response.body) throw new Error(`list download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("list too large");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("list too large");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Download and validate one list. Mirrors the on-device `downloadThreatFeed`.
 * The publication time is recorded for provenance only; list age is never a
 * reason to reject a list.
 */
export async function downloadThreatFeed(
  feed: WebsiteThreatFeed,
  fetchImpl: typeof fetch,
): Promise<{ body: string; publishedAt: string | null; entries: number }> {
  const headers = { "user-agent": USER_AGENT };
  const validate = (body: string, publishedAt: number) => ({
    body,
    publishedAt: Number.isFinite(publishedAt) ? new Date(publishedAt).toISOString() : null,
    entries: scanThreatList(body, feed).entries,
  });
  try {
    const response = await fetchImpl(feed.url, {
      headers,
      redirect: NO_REDIRECTS,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readBoundedText(response, feed.maxBytes);
    return validate(
      body,
      feed.publishedAt === "hagezi-header"
        ? hageziPublishedAt(body)
        : Date.parse(response.headers.get("last-modified") ?? ""),
    );
  } catch (error) {
    if (!feed.githubMirror) throw error;
    // The public commit feed gives the latest commit and its time without the
    // unauthenticated REST API, whose 60/hour limit is shared by egress IPs.
    const { repo, path } = feed.githubMirror;
    const atom = await readBoundedText(
      await fetchImpl(`https://github.com/${repo}/commits/master/${path}.atom`, {
        headers,
        redirect: NO_REDIRECTS,
        signal: AbortSignal.timeout(10_000),
      }),
      512 * 1024,
    );
    const entry = atom.match(/<entry>[\s\S]*?<\/entry>/)?.[0] ?? "";
    const sha = entry.match(/Grit::Commit\/([a-f0-9]{40})</)?.[1];
    if (!sha) throw new Error("invalid list mirror provenance");
    const body = await readBoundedText(
      await fetchImpl(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`, {
        headers,
        redirect: NO_REDIRECTS,
        signal: AbortSignal.timeout(30_000),
      }),
      feed.maxBytes,
    );
    return validate(body, Date.parse(entry.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? ""));
  }
}

export interface WebsiteReputationRefreshSummary {
  snapshotId: string;
  rebuilt: boolean;
  recordCount: number;
  lists: Array<
    Pick<WebsiteReputationManifestList, "id" | "state" | "entries" | "sha256" | "error">
  >;
}

interface ListOutcome extends WebsiteReputationManifestList {
  feed: WebsiteThreatFeed;
}

async function storedBody(bucket: RuntimeR2Bucket, feed: WebsiteThreatFeed) {
  const object = await bucket.get(websiteReputationListKey(feed.id));
  if (!object) return null;
  const body = await object.text();
  const meta = object.customMetadata ?? {};
  if (meta.sha256 !== sha256(body)) throw new Error("stored list failed its integrity check");
  return { body, meta };
}

export async function refreshWebsiteReputationIndex(
  options: {
    bucket?: RuntimeR2Bucket | null;
    fetchImpl?: typeof fetch;
    now?: () => number;
    feeds?: readonly WebsiteThreatFeed[];
  } = {},
): Promise<WebsiteReputationRefreshSummary> {
  const bucket = options.bucket === undefined ? getRuntimeR2Bucket() : options.bucket;
  if (!bucket) throw new Error("R2 storage is not configured");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const feeds = options.feeds ?? WEBSITE_THREAT_FEEDS;
  if (!feeds.length || feeds.length > 8 || new Set(feeds.map((f) => f.id)).size !== feeds.length) {
    throw new Error("invalid website threat list configuration");
  }
  const previous = await readWebsiteReputationManifest(bucket).catch(() => null);

  const outcomes: ListOutcome[] = [];
  for (const feed of feeds) {
    const base = {
      feed,
      id: feed.id,
      source: feed.source,
      category: feed.category,
      url: feed.url,
      license: feed.license,
      licenseUrl: feed.licenseUrl,
      reviewState: feed.reviewState,
      bit: null,
    };
    try {
      const { body, publishedAt, entries } = await downloadThreatFeed(feed, fetchImpl);
      const digest = sha256(body);
      const fetchedAt = new Date(now()).toISOString();
      const stored = bucket.head ? await bucket.head(websiteReputationListKey(feed.id)) : null;
      if (stored?.customMetadata?.sha256 !== digest) {
        await bucket.put(websiteReputationListKey(feed.id), body, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
          customMetadata: {
            sha256: digest,
            url: feed.url,
            ...(publishedAt ? { publishedAt } : {}),
            fetchedAt,
            entries: String(entries),
          },
        });
      }
      outcomes.push({
        ...base,
        state: "refreshed",
        publishedAt,
        fetchedAt,
        sha256: digest,
        bytes: new TextEncoder().encode(body).length,
        entries,
      });
    } catch (error) {
      // Keep the last-good list. It counts at any age.
      const lastGood = await storedBody(bucket, feed).catch(() => null);
      if (lastGood) {
        outcomes.push({
          ...base,
          state: "last-good",
          publishedAt: lastGood.meta.publishedAt ?? null,
          fetchedAt: lastGood.meta.fetchedAt ?? null,
          sha256: lastGood.meta.sha256 ?? null,
          bytes: new TextEncoder().encode(lastGood.body).length,
          entries: scanThreatList(lastGood.body, feed).entries,
          error: reason(error),
        });
      } else {
        outcomes.push({
          ...base,
          state: "unavailable",
          publishedAt: null,
          fetchedAt: null,
          sha256: null,
          bytes: null,
          entries: null,
          error: reason(error),
        });
      }
    }
  }

  const available = outcomes.filter((outcome) => outcome.sha256 !== null);
  if (!available.length) throw new Error("no website threat list is available");
  available.forEach((outcome, index) => {
    outcome.bit = index;
  });
  const checkedAt = new Date(now()).toISOString();
  const manifestLists = outcomes.map(({ feed: _feed, ...list }) => list);
  const summary = (manifest: WebsiteReputationManifest, rebuilt: boolean) => ({
    snapshotId: manifest.snapshotId,
    rebuilt,
    recordCount: manifest.recordCount,
    lists: manifest.lists.map(({ id, state, entries, sha256, error }) => ({
      id,
      state,
      entries,
      sha256,
      ...(error ? { error } : {}),
    })),
  });

  const unchanged =
    previous !== null &&
    previous.lists.length === manifestLists.length &&
    manifestLists.every((list, index) => {
      const old = previous.lists[index];
      return old.id === list.id && old.sha256 === list.sha256 && old.bit === list.bit;
    });
  if (unchanged && previous) {
    const manifest: WebsiteReputationManifest = { ...previous, checkedAt, lists: manifestLists };
    await putManifest(bucket, manifest);
    return summary(manifest, false);
  }

  const builder = new ShardBuilder(
    available.reduce((sum, outcome) => sum + (outcome.entries ?? 0), 0),
  );
  for (const outcome of available) {
    const stored = await storedBody(bucket, outcome.feed);
    if (!stored || stored.meta.sha256 !== outcome.sha256) {
      throw new Error(`stored list ${outcome.id} changed during the build`);
    }
    const bit = outcome.bit as number;
    scanThreatList(stored.body, outcome.feed, (host) => {
      builder.add(createHash("sha256").update(host).digest(), bit);
    });
  }
  const slot = previous?.slot === "a" ? "b" : "a";
  const snapshotId = `${checkedAt.replace(/[-:.]/g, "")}-${sha256(
    available.map((outcome) => outcome.sha256).join(","),
  ).slice(0, 12)}`;
  let recordCount = 0;
  for (let shard = 0; shard < SHARD_COUNT; shard++) {
    const bytes = builder.finish(shard);
    recordCount += bytes.length / RECORD_BYTES;
    await bucket.put(websiteReputationShardKey(slot, shard), bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { snapshotId },
    });
  }
  const manifest: WebsiteReputationManifest = {
    version: 1,
    snapshotId,
    slot,
    generatedAt: checkedAt,
    checkedAt,
    recordCount,
    lists: manifestLists,
  };
  // Switching the manifest last keeps the previous snapshot served until the new one is complete.
  await putManifest(bucket, manifest);
  return summary(manifest, true);
}

async function putManifest(bucket: RuntimeR2Bucket, manifest: WebsiteReputationManifest) {
  await bucket.put(WEBSITE_REPUTATION_MANIFEST_KEY, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  });
}
