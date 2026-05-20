#!/usr/bin/env bun

/**
 * Feed Health Report
 *
 * Direct-DB snapshot of feed content quality, duplicate detection, NPC post
 * distribution, article health, group chat quality, and staleness.
 * No server required — reads live DB state and flags problems instantly.
 *
 * Usage:
 *   bun run report:feed
 *   bun run report:feed -- --json
 *   bun run report:feed -- --hours=6   (narrow window, default 24)
 */

import { parseArgs } from 'node:util';
import { getRawDrizzle } from '@babylon/db';
import { chats, messages, posts } from '@babylon/db/schema';
import { getAllActors, getAllOrganizations } from '@babylon/engine';
import { and, desc, gte, isNull, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    json: { type: 'boolean', default: false },
    hours: { type: 'string', default: '24' },
  },
  strict: false,
});

const outputJson = args.json ?? false;
const windowHours = Math.max(1, Number.parseInt(args.hours ?? '24', 10));

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
const STALE_NPC_POST_MIN = 30; // no NPC post in this many minutes → STALE
const STALE_ORG_POST_MIN = 15; // no org post in this many minutes → STALE
const ARTICLES_PER_HOUR_WARN = 6; // more than this per hour → flood
const GROUP_MSG_PER_HOUR_WARN = 20; // more than this per chat/hour → flood
const GROUP_MSG_MIN_CHARS = 20; // below this → too short
const NPC_FLOOD_WARN = 6; // NPC posting more than this in window → flood
const ORG_FLOOD_WARN = 10; // org posting more than this in window → flood
const EXACT_DUPE_WINDOW_MIN = 60; // look for exact dupes within this window
const FIRST_WORDS_DUPE_WINDOW_MIN = 30; // look for first-N-word dupes
const FIRST_WORDS_N = 8; // words to compare for near-dupe check
const SAME_AUTHOR_DUPE_WINDOW_MIN = 30; // same author near-dupe window

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------
const reset = '\x1b[0m';
const bold = '\x1b[1m';
const red = '\x1b[31m';
const yellow = '\x1b[33m';
const green = '\x1b[32m';
const cyan = '\x1b[36m';
const dim = '\x1b[2m';

const OK = `${green}[OK]  ${reset}`;
const WARN = `${yellow}[WARN]${reset}`;
const ERR = `${red}[ERR] ${reset}`;

function ago(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h${mins % 60}m ago`;
}

// ---------------------------------------------------------------------------
// Types for JSON output
// ---------------------------------------------------------------------------
interface FeedHealthReport {
  generatedAt: string;
  windowHours: number;
  distribution: DistributionSection;
  duplicates: DuplicateSection;
  articles: ArticleSection;
  groupChats: GroupChatSection;
  staleness: StalenessSection;
}

interface DistributionSection {
  totalPosts: number;
  byType: Record<string, number>;
  byCategory: Record<string, number>;
  npcTopPosters: Array<{ id: string; count: number; flags: string[] }>;
  orgTopPosters: Array<{ id: string; count: number; flags: string[] }>;
}

interface DuplicateSection {
  exactDupes: Array<{ content: string; count: number; authors: string[] }>;
  firstWordsDupes: Array<{
    prefix: string;
    count: number;
    authors: string[];
  }>;
  sameAuthorNearDupes: Array<{
    authorId: string;
    content1: string;
    content2: string;
    windowMin: number;
  }>;
  warnings: number;
}

interface ArticleSection {
  totalArticles: number;
  hourlyBuckets: Array<{ hour: string; count: number; flags: string[] }>;
  warnings: number;
}

interface GroupChatSection {
  totalGroupChats: number;
  recentMessages: number;
  shortMessages: Array<{ chatId: string; senderId: string; content: string }>;
  floodedChats: Array<{ chatId: string; msgsPerHour: number }>;
  warnings: number;
}

interface StalenessSection {
  lastNpcPostAt: string | null;
  lastOrgPostAt: string | null;
  lastArticleAt: string | null;
  npcStale: boolean;
  orgStale: boolean;
  warnings: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function firstNWords(text: string, n: number): string {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, n)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run(): Promise<FeedHealthReport> {
  const db = getRawDrizzle();
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const exactDupeStart = new Date(
    now.getTime() - EXACT_DUPE_WINDOW_MIN * 60 * 1000
  );
  const firstWordsDupeStart = new Date(
    now.getTime() - FIRST_WORDS_DUPE_WINDOW_MIN * 60 * 1000
  );
  const sameAuthorDupeStart = new Date(
    now.getTime() - SAME_AUTHOR_DUPE_WINDOW_MIN * 60 * 1000
  );

  // Load actor / org sets for categorization
  const allActors = getAllActors();
  const allOrgs = getAllOrganizations();
  const npcIds = new Set(allActors.map((a) => a.id));
  const orgIds = new Set(allOrgs.map((o) => o.id));

  // -------------------------------------------------------------------------
  // 1. Raw post query for window
  // -------------------------------------------------------------------------
  const rawPosts = await db
    .select({
      id: posts.id,
      content: posts.content,
      authorId: posts.authorId,
      type: posts.type,
      timestamp: posts.timestamp,
      commentOnPostId: posts.commentOnPostId,
      parentCommentId: posts.parentCommentId,
    })
    .from(posts)
    .where(
      and(
        gte(posts.timestamp, windowStart),
        isNull(posts.deletedAt),
        isNull(posts.commentOnPostId),
        isNull(posts.parentCommentId)
      )
    )
    .orderBy(desc(posts.timestamp));

  // -------------------------------------------------------------------------
  // 2. Distribution
  // -------------------------------------------------------------------------
  const byType: Record<string, number> = {};
  const byCategory: Record<string, number> = {
    npc: 0,
    org: 0,
    user: 0,
    agent: 0,
    unknown: 0,
  };
  const postsByNpc: Record<string, number> = {};
  const postsByOrg: Record<string, number> = {};

  for (const p of rawPosts) {
    byType[p.type] = (byType[p.type] ?? 0) + 1;
    if (npcIds.has(p.authorId)) {
      byCategory.npc++;
      postsByNpc[p.authorId] = (postsByNpc[p.authorId] ?? 0) + 1;
    } else if (orgIds.has(p.authorId)) {
      byCategory.org++;
      postsByOrg[p.authorId] = (postsByOrg[p.authorId] ?? 0) + 1;
    } else {
      byCategory.unknown++;
    }
  }

  const npcTopPosters = Object.entries(postsByNpc)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, count]) => ({
      id,
      count,
      flags: count > NPC_FLOOD_WARN ? ['FLOOD'] : [],
    }));

  const orgTopPosters = Object.entries(postsByOrg)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, count]) => ({
      id,
      count,
      flags: count > ORG_FLOOD_WARN ? ['FLOOD'] : [],
    }));

  // -------------------------------------------------------------------------
  // 3. Duplicate detection
  // -------------------------------------------------------------------------

  // 3a. Exact duplicate content in window
  const recentForDupeCheck = rawPosts.filter(
    (p) => p.timestamp >= exactDupeStart
  );
  const contentMap: Record<string, { count: number; authors: string[] }> = {};
  for (const p of recentForDupeCheck) {
    const key = p.content.trim().toLowerCase();
    if (!contentMap[key]) {
      contentMap[key] = { count: 0, authors: [] };
    }
    contentMap[key].count++;
    if (!contentMap[key].authors.includes(p.authorId)) {
      contentMap[key].authors.push(p.authorId);
    }
  }
  const exactDupes = Object.entries(contentMap)
    .filter(([, v]) => v.count > 1)
    .map(([content, v]) => ({
      content: content.slice(0, 80) + (content.length > 80 ? '…' : ''),
      count: v.count,
      authors: v.authors,
    }));

  // 3b. First-N-words near-dupes across different authors in short window
  const recentForFirstWords = rawPosts.filter(
    (p) => p.timestamp >= firstWordsDupeStart
  );
  const prefixMap: Record<string, { count: number; authors: string[] }> = {};
  for (const p of recentForFirstWords) {
    const prefix = firstNWords(p.content, FIRST_WORDS_N);
    if (prefix.split(' ').length < 4) continue; // too short to be meaningful
    if (!prefixMap[prefix]) {
      prefixMap[prefix] = { count: 0, authors: [] };
    }
    prefixMap[prefix].count++;
    if (!prefixMap[prefix].authors.includes(p.authorId)) {
      prefixMap[prefix].authors.push(p.authorId);
    }
  }
  const firstWordsDupes = Object.entries(prefixMap)
    .filter(([, v]) => v.count > 1 && v.authors.length > 1)
    .map(([prefix, v]) => ({ prefix, count: v.count, authors: v.authors }));

  // 3c. Same-author near-dupes (first N words match, within time window)
  const recentForSameAuthor = rawPosts.filter(
    (p) => p.timestamp >= sameAuthorDupeStart
  );
  const authorPrefixMap: Record<
    string,
    Array<{ prefix: string; content: string }>
  > = {};
  for (const p of recentForSameAuthor) {
    const prefix = firstNWords(p.content, FIRST_WORDS_N);
    if (!authorPrefixMap[p.authorId]) {
      authorPrefixMap[p.authorId] = [];
    }
    authorPrefixMap[p.authorId].push({ prefix, content: p.content });
  }
  const sameAuthorNearDupes: DuplicateSection['sameAuthorNearDupes'] = [];
  for (const [authorId, items] of Object.entries(authorPrefixMap)) {
    const seen = new Map<string, string>();
    for (const item of items) {
      if (seen.has(item.prefix)) {
        sameAuthorNearDupes.push({
          authorId,
          content1: (seen.get(item.prefix) ?? '').slice(0, 80),
          content2: item.content.slice(0, 80),
          windowMin: SAME_AUTHOR_DUPE_WINDOW_MIN,
        });
      } else {
        seen.set(item.prefix, item.content);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Article health (hourly buckets, last 6h capped at windowHours)
  // -------------------------------------------------------------------------
  const articleWindow = Math.min(windowHours, 6);
  const articleWindowStart = new Date(
    now.getTime() - articleWindow * 60 * 60 * 1000
  );

  const articlePosts = await db
    .select({
      timestamp: posts.timestamp,
    })
    .from(posts)
    .where(
      and(
        gte(posts.timestamp, articleWindowStart),
        isNull(posts.deletedAt),
        sql`${posts.type} = 'article'`
      )
    )
    .orderBy(desc(posts.timestamp));

  const hourlyBuckets: ArticleSection['hourlyBuckets'] = [];
  for (let h = 0; h < articleWindow; h++) {
    const bucketStart = new Date(now.getTime() - (h + 1) * 60 * 60 * 1000);
    const bucketEnd = new Date(now.getTime() - h * 60 * 60 * 1000);
    const count = articlePosts.filter(
      (p) => p.timestamp >= bucketStart && p.timestamp < bucketEnd
    ).length;
    hourlyBuckets.unshift({
      hour: bucketStart.toISOString().slice(0, 13) + ':00',
      count,
      flags: count > ARTICLES_PER_HOUR_WARN ? ['FLOOD'] : [],
    });
  }

  // -------------------------------------------------------------------------
  // 5. Group chat quality
  // -------------------------------------------------------------------------
  const chatWindowStart = new Date(now.getTime() - 60 * 60 * 1000); // last 1h
  const groupChatIds = await db
    .select({ id: chats.id })
    .from(chats)
    .where(sql`${chats.isGroup} = true`);

  const groupChatIdSet = new Set(groupChatIds.map((c) => c.id));
  const totalGroupChats = groupChatIdSet.size;

  let recentMessages = 0;
  const shortMessages: GroupChatSection['shortMessages'] = [];
  const msgsPerChat: Record<string, number> = {};

  if (groupChatIdSet.size > 0) {
    const recentMsgs = await db
      .select({
        chatId: messages.chatId,
        senderId: messages.senderId,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(gte(messages.createdAt, chatWindowStart))
      .orderBy(desc(messages.createdAt));

    for (const msg of recentMsgs) {
      if (!groupChatIdSet.has(msg.chatId)) continue;
      recentMessages++;
      msgsPerChat[msg.chatId] = (msgsPerChat[msg.chatId] ?? 0) + 1;
      if (msg.content.trim().length < GROUP_MSG_MIN_CHARS) {
        shortMessages.push({
          chatId: msg.chatId,
          senderId: msg.senderId,
          content: msg.content.trim(),
        });
      }
    }
  }

  const floodedChats = Object.entries(msgsPerChat)
    .filter(([, count]) => count > GROUP_MSG_PER_HOUR_WARN)
    .map(([chatId, count]) => ({ chatId, msgsPerHour: count }));

  // -------------------------------------------------------------------------
  // 6. Staleness
  // -------------------------------------------------------------------------
  const allTopLevel = rawPosts; // already filtered to top-level in window

  const lastNpcPost = allTopLevel.find((p) => npcIds.has(p.authorId));
  const lastOrgPost = allTopLevel.find((p) => orgIds.has(p.authorId));

  const lastArticle = rawPosts.find((p) => p.type === 'article');

  const npcStaleMins = lastNpcPost
    ? (now.getTime() - lastNpcPost.timestamp.getTime()) / 60000
    : Number.POSITIVE_INFINITY;
  const orgStaleMins = lastOrgPost
    ? (now.getTime() - lastOrgPost.timestamp.getTime()) / 60000
    : Number.POSITIVE_INFINITY;

  const npcStale = npcStaleMins > STALE_NPC_POST_MIN;
  const orgStale = orgStaleMins > STALE_ORG_POST_MIN;

  // -------------------------------------------------------------------------
  // Assemble report
  // -------------------------------------------------------------------------
  const report: FeedHealthReport = {
    generatedAt: now.toISOString(),
    windowHours,
    distribution: {
      totalPosts: rawPosts.length,
      byType,
      byCategory,
      npcTopPosters,
      orgTopPosters,
    },
    duplicates: {
      exactDupes,
      firstWordsDupes,
      sameAuthorNearDupes,
      warnings:
        exactDupes.length + firstWordsDupes.length + sameAuthorNearDupes.length,
    },
    articles: {
      totalArticles: articlePosts.length,
      hourlyBuckets,
      warnings: hourlyBuckets.filter((b) => b.flags.includes('FLOOD')).length,
    },
    groupChats: {
      totalGroupChats,
      recentMessages,
      shortMessages: shortMessages.slice(0, 20),
      floodedChats,
      warnings: shortMessages.length + floodedChats.length,
    },
    staleness: {
      lastNpcPostAt: lastNpcPost?.timestamp.toISOString() ?? null,
      lastOrgPostAt: lastOrgPost?.timestamp.toISOString() ?? null,
      lastArticleAt: lastArticle?.timestamp.toISOString() ?? null,
      npcStale,
      orgStale,
      warnings: (npcStale ? 1 : 0) + (orgStale ? 1 : 0),
    },
  };

  return report;
}

// ---------------------------------------------------------------------------
// Human-readable printer
// ---------------------------------------------------------------------------
function printReport(r: FeedHealthReport): void {
  const line = `${dim}${'─'.repeat(70)}${reset}`;
  console.log(
    `\n${bold}${cyan}=== FEED HEALTH REPORT — ${r.generatedAt} ===${reset}`
  );
  console.log(`${dim}Window: last ${r.windowHours}h${reset}\n`);

  // Distribution
  console.log(`${bold}POST DISTRIBUTION${reset}`);
  console.log(line);
  const d = r.distribution;
  console.log(`  Total top-level posts: ${bold}${d.totalPosts}${reset}`);
  console.log('  By type:');
  for (const [type, count] of Object.entries(d.byType).sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`    ${type.padEnd(22)} ${count}`);
  }
  console.log('  By author category:');
  for (const [cat, count] of Object.entries(d.byCategory)) {
    console.log(`    ${cat.padEnd(22)} ${count}`);
  }
  if (d.npcTopPosters.length > 0) {
    console.log('  Top NPC posters:');
    for (const p of d.npcTopPosters.slice(0, 5)) {
      const flag =
        p.flags.length > 0 ? ` ${yellow}[${p.flags.join(',')}]${reset}` : '';
      console.log(`    ${p.id.padEnd(30)} ${p.count} posts${flag}`);
    }
  }
  if (d.orgTopPosters.length > 0) {
    console.log('  Top org posters:');
    for (const p of d.orgTopPosters.slice(0, 5)) {
      const flag =
        p.flags.length > 0 ? ` ${yellow}[${p.flags.join(',')}]${reset}` : '';
      console.log(`    ${p.id.padEnd(30)} ${p.count} posts${flag}`);
    }
  }

  // Duplicates
  console.log(`\n${bold}DUPLICATE DETECTION${reset}`);
  console.log(line);
  const dup = r.duplicates;
  if (
    dup.exactDupes.length === 0 &&
    dup.firstWordsDupes.length === 0 &&
    dup.sameAuthorNearDupes.length === 0
  ) {
    console.log(`  ${OK} No duplicates detected in window`);
  }
  for (const d of dup.exactDupes) {
    console.log(
      `  ${ERR} Exact dupe ×${d.count}: "${d.content}" (authors: ${d.authors.slice(0, 3).join(', ')})`
    );
  }
  for (const d of dup.firstWordsDupes) {
    console.log(
      `  ${WARN} First-${FIRST_WORDS_N}-words dupe ×${d.count}: "${d.prefix}…" (authors: ${d.authors.slice(0, 3).join(', ')})`
    );
  }
  for (const d of dup.sameAuthorNearDupes.slice(0, 5)) {
    console.log(
      `  ${WARN} Same-author near-dupe within ${d.windowMin}min: [${d.authorId}]`
    );
    console.log(`    A: "${d.content1}"`);
    console.log(`    B: "${d.content2}"`);
  }

  // Articles
  console.log(
    `\n${bold}ARTICLE HEALTH (last ${Math.min(r.windowHours, 6)}h)${reset}`
  );
  console.log(line);
  const art = r.articles;
  console.log(`  Total articles: ${art.totalArticles}`);
  for (const b of art.hourlyBuckets) {
    const flag = b.flags.includes('FLOOD')
      ? ` ${WARN} FLOOD > ${ARTICLES_PER_HOUR_WARN}/hr`
      : '';
    console.log(`  ${b.hour}  ${String(b.count).padStart(3)} articles${flag}`);
  }
  if (art.warnings === 0) {
    console.log(`  ${OK} Article rate nominal`);
  }

  // Group chats
  console.log(`\n${bold}GROUP CHAT QUALITY (last 1h)${reset}`);
  console.log(line);
  const gc = r.groupChats;
  console.log(
    `  Group chats: ${gc.totalGroupChats}   Messages (1h): ${gc.recentMessages}`
  );
  if (gc.floodedChats.length > 0) {
    for (const f of gc.floodedChats) {
      console.log(
        `  ${WARN} Chat flood: ${f.chatId} — ${f.msgsPerHour} msgs/hr (>${GROUP_MSG_PER_HOUR_WARN})`
      );
    }
  }
  if (gc.shortMessages.length > 0) {
    console.log(
      `  ${WARN} ${gc.shortMessages.length} messages under ${GROUP_MSG_MIN_CHARS} chars:`
    );
    for (const m of gc.shortMessages.slice(0, 5)) {
      console.log(`    [${m.senderId}] "${m.content}"`);
    }
  }
  if (gc.warnings === 0) {
    console.log(`  ${OK} Group chat quality nominal`);
  }

  // Staleness
  console.log(`\n${bold}FEED STALENESS${reset}`);
  console.log(line);
  const s = r.staleness;
  const npcLabel = s.lastNpcPostAt
    ? ago(new Date(s.lastNpcPostAt))
    : 'never (in window)';
  const orgLabel = s.lastOrgPostAt
    ? ago(new Date(s.lastOrgPostAt))
    : 'never (in window)';
  const artLabel = s.lastArticleAt
    ? ago(new Date(s.lastArticleAt))
    : 'none in window';

  console.log(
    `  ${s.npcStale ? WARN : OK} Last NPC post:     ${npcLabel}${s.npcStale ? ` ${yellow}(>${STALE_NPC_POST_MIN}min — cron may be down?)${reset}` : ''}`
  );
  console.log(
    `  ${s.orgStale ? WARN : OK} Last org post:     ${orgLabel}${s.orgStale ? ` ${yellow}(>${STALE_ORG_POST_MIN}min — org-tick may be down?)${reset}` : ''}`
  );
  console.log(`  ${OK} Last article:      ${artLabel}`);

  // Summary
  const totalWarnings =
    r.duplicates.warnings +
    r.articles.warnings +
    r.groupChats.warnings +
    r.staleness.warnings;

  console.log(`\n${bold}SUMMARY${reset}`);
  console.log(line);
  if (totalWarnings === 0) {
    console.log(`  ${OK} Feed is healthy — no warnings\n`);
  } else {
    console.log(`  ${WARN} ${totalWarnings} warning(s) found — review above\n`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const report = await run();

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}
