/**
 * Feed algorithm utilities — pure functions with no React or browser deps.
 *
 * Extracted from the component files so both the rendering components and
 * unit tests can import the real implementation rather than maintaining copies.
 */

import type { FeedPost, NarrativePost, NarrativeStory } from "@feed/shared";
import type { NewMarketEntry } from "@/app/api/feed/new-markets/route";

// ─── flattenStories ───────────────────────────────────────────────────────────

export type FlatItem =
  | {
      type: "post";
      post: NarrativePost;
      key: string;
      marketId: string | null;
      story?: NarrativeStory;
    }
  | { type: "market"; story: NarrativeStory; key: string };

/**
 * How many consecutive posts to show from a story before rotating to the next.
 *
 * Reduced to 2 (from 3) so a single news org can't emit three back-to-back
 * posts before the rotation switches to a different story/source.
 * The top-scored story gets BURST_LEAD posts on its first appearance so the
 * highest-signal content surfaces clearly at the top.
 */
export const BURST_SIZE = 2;
export const BURST_LEAD = 3;

/**
 * Flatten scored stories into an interleaved burst list.
 *
 * Market cards (isNewMarket) are separated from post-stories and injected
 * one-per-rotation so they appear throughout the feed rather than clustering
 * at the top. Without separation, market cards score near 1.0 (brand-new
 * recency) and beat all posts, causing every market to appear before any post.
 *
 * Layout produced (3 stories, 2 markets):
 *   [A×BURST_LEAD] [B×BURST_SIZE] [C×BURST_SIZE] [Market1]
 *   [A×BURST_SIZE] [B×BURST_SIZE] [C×BURST_SIZE] [Market2]
 *   [A remaining…]
 */
export function flattenStories(stories: NarrativeStory[]): FlatItem[] {
  const items: FlatItem[] = [];

  // Separate market cards from post-stories so market cards can be
  // injected at controlled intervals rather than all before the first post.
  const pendingMarkets = stories.filter((s) => s.isNewMarket);
  const postStories = stories.filter((s) => !s.isNewMarket);

  if (postStories.length === 0) {
    // No posts at all — just emit the market cards in score order
    for (const m of pendingMarkets) {
      items.push({ type: "market", story: m, key: m.storyKey });
    }
    return items;
  }

  const queues = postStories.map((s) => ({
    story: s,
    posts: s.posts.filter((post): post is NarrativePost => Boolean(post)),
    firstAppearance: true,
  }));

  let marketIdx = 0;
  let anyLeft = true;

  while (anyLeft) {
    anyLeft = false;

    for (const q of queues) {
      if (q.posts.length === 0) continue;

      // Top post-story gets extra posts on first appearance for prominence
      const burst =
        q.firstAppearance && queues.indexOf(q) === 0 ? BURST_LEAD : BURST_SIZE;
      q.firstAppearance = false;

      let took = 0;
      while (took < burst && q.posts.length > 0) {
        const post = q.posts.shift()!;
        items.push({
          type: "post",
          post,
          key: `${q.story.storyKey}:${post.id}`,
          marketId: q.story.marketId ?? null,
          story: q.story,
        });
        took++;
      }
      anyLeft = true;
    }

    // After each complete rotation of all post-stories, inject one market card.
    // This spaces market cards evenly through the stream instead of clustering
    // them all before the first post.
    if (marketIdx < pendingMarkets.length) {
      const m = pendingMarkets[marketIdx++]!;
      items.push({ type: "market", story: m, key: m.storyKey });
    }
  }

  // Append any market cards that didn't fit within the post rotations
  while (marketIdx < pendingMarkets.length) {
    const m = pendingMarkets[marketIdx++]!;
    items.push({ type: "market", story: m, key: m.storyKey });
  }

  return items;
}

// ─── applySlotPattern ─────────────────────────────────────────────────────────

/**
 * Repeating slot pattern for the Stories feed.
 *
 * [actor, actor, news, market] produces roughly:
 *   50% actor/user posts (individual NPC personalities + real users)
 *   25% news posts (org NPC media posts + articles)
 *   25% market cards (newly opened prediction markets)
 *
 * When a bucket runs dry, the next available bucket fills the slot.
 * Author deduplication prevents two consecutive posts from the same author
 * within the actor or news buckets.
 */
export const SLOT_PATTERN = ["actor", "actor", "news", "market"] as const;
type SlotType = (typeof SLOT_PATTERN)[number];

/**
 * Re-order a flat item list into balanced content-type slots.
 *
 * Classification:
 *   market → `item.type === 'market'`
 *   news   → `item.post.authorType === 'news'` OR `item.post.type === 'article'`
 *   actor  → everything else (individual NPCs + real users)
 */
export function applySlotPattern(items: FlatItem[]): FlatItem[] {
  const buckets: Record<SlotType, FlatItem[]> = {
    actor: [],
    news: [],
    market: [],
  };

  for (const item of items) {
    if (item.type === "market") {
      buckets.market.push(item);
    } else if (
      item.post.authorType === "news" ||
      item.post.type === "article"
    ) {
      buckets.news.push(item);
    } else {
      buckets.actor.push(item);
    }
  }

  const result: FlatItem[] = [];
  let slotIdx = 0;
  let lastAuthorId: string | null = null;

  while (result.length < items.length) {
    const want = SLOT_PATTERN[slotIdx % SLOT_PATTERN.length]!;
    slotIdx++;

    // Find the preferred bucket, fall back to any non-empty bucket
    let bucket = buckets[want];
    if (bucket.length === 0) {
      bucket =
        buckets.actor.length > 0
          ? buckets.actor
          : buckets.news.length > 0
            ? buckets.news
            : buckets.market.length > 0
              ? buckets.market
              : null!;
      if (!bucket) break;
    }

    // Author dedup: if the next item shares an authorId with the last emitted
    // post, rotate it to the back of its bucket (once) so a different author
    // surfaces first. Only applies when the bucket has more than one item.
    if (
      bucket.length > 1 &&
      lastAuthorId !== null &&
      bucket[0]?.type === "post" &&
      bucket[0]?.post.authorId === lastAuthorId
    ) {
      bucket.push(bucket.shift()!);
    }

    const item = bucket.shift()!;
    result.push(item);
    lastAuthorId = item.type === "post" ? item.post.authorId : null;
  }

  return result;
}

// ─── mergeChronologically ─────────────────────────────────────────────────────

export type MixedItem =
  | { type: "post"; post: FeedPost }
  | { type: "market"; market: NewMarketEntry };

/**
 * Merge a post list and a market list into a single newest-first stream.
 *
 * A market opened 30 minutes ago will appear between posts that are
 * 25 and 35 minutes old — not batched at the top. Both lists must already
 * be sorted newest-first; this function does a single sort over the combined
 * array.
 */
export function mergeChronologically(
  posts: FeedPost[],
  markets: NewMarketEntry[],
): MixedItem[] {
  const all: MixedItem[] = [
    ...posts.map((p) => ({ type: "post" as const, post: p })),
    ...markets.map((m) => ({ type: "market" as const, market: m })),
  ];
  return all.sort((a, b) => {
    const ta =
      a.type === "post"
        ? new Date(a.post.timestamp).getTime()
        : new Date(a.market.createdAt).getTime();
    const tb =
      b.type === "post"
        ? new Date(b.post.timestamp).getTime()
        : new Date(b.market.createdAt).getTime();
    return tb - ta;
  });
}
