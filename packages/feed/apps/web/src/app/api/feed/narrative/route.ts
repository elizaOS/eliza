/**
 * Narrative Feed API
 *
 * @route GET /api/feed/narrative — story-grouped feed sorted by narrative score
 *
 * Story Scoring:
 *   storyScore = totalEngagement * 0.5 + recencyScore * 0.35 + activityBonus * 0.15
 *   totalEngagement = sum(likes*1 + comments*2 + shares*3)
 *   recencyScore    = Math.exp(-ln(2) * hoursOld / 12)   // true 12h half-life on newest post
 *   activityBonus   = Math.min(postCount / 10, 1)
 *
 * Posts from the last 48h are fetched, grouped by relatedQuestion (prediction market
 * question number), scored per story group, and returned sorted by score DESC.
 * Posts without a relatedQuestion are collected into a synthetic "__general__" story
 * that always sorts last.
 */
import {
  addPublicReadHeaders,
  getCache,
  getCacheOrFetch,
  narrativeEnrichmentKey,
  publicRateLimit,
  setCache,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  arcStates,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  markets,
  not,
  positions,
  posts,
  questions,
  reactions,
  shares,
  sql,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import type {
  ArcStateType,
  NarrativePost,
  NarrativeStory,
} from '@feed/shared';
import { logger, toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { compareFeedStories } from '../feed-cursor';
import { dedupeQuestionMarketRows } from '../questionMarketRows';
import {
  calculateArcStateMultiplier,
  calculateResolutionBoost,
  calculateStoryScore,
} from './scoring';

// Query limits
const MAX_CANDIDATE_POSTS = 500;
// 12-hour window: markets change frequently; this keeps the feed current
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
// New market lookback: questions opened in this window get a "New Market" card
const NEW_MARKET_WINDOW_MS = 24 * 60 * 60 * 1000;

// Top-N general (non-question) posts surfaced as individual story cards.
// These compete on score alongside question stories to create the
// "stories + hot + latest" blend the feed aims for.
const MAX_STANDALONE_POSTS = 20;

// Minimum score for a standalone post card to appear in the feed.
// Prevents spam of zero-engagement posts from drowning active stories.
const MIN_STANDALONE_SCORE = 0.05;

const GENERAL_STORY_KEY = '__general__';

interface NarrativeFeedResponse {
  success: true;
  stories: NarrativeStory[];
  generatedAt: string;
}

function toISOStringStrict(
  date: Date | string | null | undefined,
  fieldName: string,
  postId: string
): string {
  if (date === null || date === undefined) {
    logger.warn(
      `Null/undefined ${fieldName} for post ${postId}`,
      { postId },
      'NarrativeFeedAPI'
    );
    return new Date().toISOString();
  }
  if (date instanceof Date) {
    if (isNaN(date.getTime())) {
      logger.warn(
        `Invalid Date for ${fieldName} on post ${postId}`,
        { postId },
        'NarrativeFeedAPI'
      );
      return new Date().toISOString();
    }
    return toISO(date);
  }
  const parsed = new Date(date);
  if (!isNaN(parsed.getTime())) return toISO(parsed);
  logger.warn(
    `Unparseable ${fieldName} "${date}" for post ${postId}`,
    { postId },
    'NarrativeFeedAPI'
  );
  return new Date().toISOString();
}

interface CachedResult {
  stories: NarrativeStory[];
  postIds: string[];
}

// Per-user enrichment cache TTL (seconds). Short enough to stay fresh;
// long enough to dramatically reduce DB load at scale.
const USER_ENRICHMENT_TTL_S = 30;

interface UserEnrichmentCache {
  likedPostIds: string[];
  sharedPostIds: string[];
  positionQuestionIds: number[];
}

export const GET = withErrorHandling(async (request: NextRequest) => {
  const {
    error: rateLimitErr,
    user,
    rateLimitInfo,
  } = await publicRateLimit(request, 'read');
  if (rateLimitErr) return rateLimitErr;

  const cacheKey = 'feed:narrative:v1';

  const result = await getCacheOrFetch<CachedResult>(
    cacheKey,
    async () => {
      const now = new Date();
      const cutoff = new Date(now.getTime() - TWELVE_HOURS_MS);
      const newMarketCutoff = new Date(now.getTime() - NEW_MARKET_WINDOW_MS);

      const recentPosts = await db
        .select({
          id: posts.id,
          content: posts.content,
          authorId: posts.authorId,
          timestamp: posts.timestamp,
          type: posts.type,
          articleTitle: posts.articleTitle,
          fullContent: posts.fullContent,
          category: posts.category,
          imageUrl: posts.imageUrl,
          relatedQuestion: posts.relatedQuestion,
          originalPostId: posts.originalPostId,
        })
        .from(posts)
        .where(
          and(
            isNull(posts.deletedAt),
            gte(posts.timestamp, cutoff),
            lte(posts.timestamp, now),
            isNull(posts.commentOnPostId),
            isNull(posts.parentCommentId)
          )
        )
        .orderBy(desc(posts.timestamp))
        .limit(MAX_CANDIDATE_POSTS);

      if (recentPosts.length === 0) {
        return { stories: [], postIds: [] };
      }

      const postIds = recentPosts.map((p) => p.id);

      // Single CTE query for all engagement counts — mirrors fetchPostMetadataConsolidated
      // pattern in apps/web/src/app/api/posts/route.ts to avoid N separate round-trips.
      const postIdsArray = sql`ARRAY[${sql.join(
        postIds.map((id) => sql`${id}`),
        sql`, `
      )}]::text[]`;

      const engagementRows = await db.execute(sql`
        WITH
        target_posts AS (
          SELECT unnest(${postIdsArray}) AS post_id
        ),
        reaction_counts AS (
          SELECT r."postId" AS post_id, COUNT(*) AS count
          FROM "Reaction" r
          INNER JOIN target_posts tp ON r."postId" = tp.post_id
          WHERE r.type = 'like'
          GROUP BY r."postId"
        ),
        comment_counts AS (
          SELECT c."postId" AS post_id, COUNT(*) AS count
          FROM "Comment" c
          INNER JOIN target_posts tp ON c."postId" = tp.post_id
          WHERE c."deletedAt" IS NULL
          GROUP BY c."postId"
        ),
        share_counts AS (
          SELECT s."postId" AS post_id, COUNT(*) AS count
          FROM "Share" s
          INNER JOIN target_posts tp ON s."postId" = tp.post_id
          GROUP BY s."postId"
        )
        SELECT
          tp.post_id,
          COALESCE(rc.count, 0) AS like_count,
          COALESCE(cc.count, 0) AS comment_count,
          COALESCE(sc.count, 0) AS share_count
        FROM target_posts tp
        LEFT JOIN reaction_counts rc ON tp.post_id = rc.post_id
        LEFT JOIN comment_counts cc ON tp.post_id = cc.post_id
        LEFT JOIN share_counts sc ON tp.post_id = sc.post_id
      `);

      const reactionMap = new Map<string, number>();
      const commentMap = new Map<string, number>();
      const shareMap = new Map<string, number>();

      const engagementResultRows = Array.isArray(engagementRows)
        ? (engagementRows as Record<string, unknown>[])
        : [];
      for (const row of engagementResultRows) {
        const postId = String(row['post_id'] ?? '');
        if (!postId) continue;
        reactionMap.set(postId, Number(row['like_count'] ?? 0));
        commentMap.set(postId, Number(row['comment_count'] ?? 0));
        shareMap.set(postId, Number(row['share_count'] ?? 0));
      }

      const authorIds = [...new Set(recentPosts.map((p) => p.authorId))];
      const authorUsers = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          profileImageUrl: users.profileImageUrl,
        })
        .from(users)
        .where(inArray(users.id, authorIds));
      const userMap = new Map(authorUsers.map((u) => [u.id, u]));

      // Fetch original posts for reposts so their content can be displayed
      // the same way as the main feed. Simple reposts have content: ""; quote
      // posts put the quote text in content and the original in originalPostId.
      const repostOriginalIds = [
        ...new Set(
          recentPosts
            .filter((p) => p.originalPostId)
            .map((p) => p.originalPostId as string)
        ),
      ];
      const originalPostMap = new Map<
        string,
        {
          id: string;
          content: string;
          authorId: string;
          timestamp: Date;
          profileImageUrl: string | null;
          username: string | null;
          displayName: string | null;
        }
      >();
      if (repostOriginalIds.length > 0) {
        const originalRows = await db
          .select({
            id: posts.id,
            content: posts.content,
            authorId: posts.authorId,
            timestamp: posts.timestamp,
          })
          .from(posts)
          .where(inArray(posts.id, repostOriginalIds));
        const originalAuthorIds = [
          ...new Set(originalRows.map((r) => r.authorId)),
        ];
        const originalAuthorUsers =
          originalAuthorIds.length > 0
            ? await db
                .select({
                  id: users.id,
                  username: users.username,
                  displayName: users.displayName,
                  profileImageUrl: users.profileImageUrl,
                })
                .from(users)
                .where(inArray(users.id, originalAuthorIds))
            : [];
        const originalUserMap = new Map(
          originalAuthorUsers.map((u) => [u.id, u])
        );
        for (const r of originalRows) {
          const u = originalUserMap.get(r.authorId);
          originalPostMap.set(r.id, {
            id: r.id,
            content: r.content,
            authorId: r.authorId,
            timestamp: r.timestamp,
            profileImageUrl: u?.profileImageUrl ?? null,
            username: u?.username ?? null,
            displayName: u?.displayName ?? null,
          });
        }
      }

      // Resolve question metadata (title, status, arcState) via posts.relatedQuestion → questions.questionNumber
      // LEFT JOIN arcStates to get narrative state in one round-trip.
      const questionNumbers = [
        ...new Set(
          recentPosts
            .map((p) => p.relatedQuestion)
            .filter((q): q is number => q !== null && q !== undefined)
        ),
      ];
      interface QuestionMeta {
        title: string;
        status: string;
        arcState: ArcStateType | null;
        resolutionDate: Date;
      }
      const questionMetaMap = new Map<number, QuestionMeta>();
      if (questionNumbers.length > 0) {
        const rows = await db
          .select({
            questionNumber: questions.questionNumber,
            text: questions.text,
            status: questions.status,
            arcState: arcStates.currentState,
            resolutionDate: questions.resolutionDate,
          })
          .from(questions)
          .leftJoin(arcStates, eq(arcStates.questionId, questions.id))
          .where(inArray(questions.questionNumber, questionNumbers));
        rows.forEach((q) =>
          questionMetaMap.set(q.questionNumber, {
            title: q.text,
            status: q.status ?? 'active',
            arcState: (q.arcState as ArcStateType | null) ?? null,
            resolutionDate: q.resolutionDate,
          })
        );
      }

      // Group posts by storyKey
      const storyPostMap = new Map<string, NarrativePost[]>();

      for (const post of recentPosts) {
        const likeCount = reactionMap.get(post.id) ?? 0;
        const commentCount = commentMap.get(post.id) ?? 0;
        const shareCount = shareMap.get(post.id) ?? 0;
        const timestamp = toISOStringStrict(
          post.timestamp,
          'timestamp',
          post.id
        );

        const authorUser = userMap.get(post.authorId);
        const actorRecord = StaticDataRegistry.getActor(post.authorId);
        // Organizations are indexed separately from individual actors; check
        // both so org-authored posts get the correct image (/images/organizations/)
        // and route to /orgs/{id} rather than the broken /u/id/ fallback.
        const orgRecord = actorRecord
          ? null
          : StaticDataRegistry.getOrganization(post.authorId);
        let authorName = post.authorId;
        let authorUsername: string | null = null;
        let authorProfileImageUrl: string | null = null;

        // Derive author type for slot-pattern classification in the frontend.
        const authorType: 'actor' | 'news' | 'user' = actorRecord
          ? 'actor'
          : orgRecord
            ? 'news'
            : 'user';

        // Filter NPC org "NEW MARKET:" announcements — these are system-generated
        // posts that duplicate the NewMarketCard component. The card is the
        // canonical feed surface; the text post adds noise. We still capture the
        // post ID below so the card's InteractionBar can anchor to it.
        if (
          orgRecord &&
          post.content.trimStart().toUpperCase().startsWith('NEW MARKET:')
        ) {
          continue;
        }

        if (actorRecord) {
          authorName = actorRecord.name;
          authorUsername = actorRecord.username ?? actorRecord.id;
          authorProfileImageUrl = actorRecord.profileImageUrl ?? null;
        } else if (orgRecord) {
          // Use org ID as the username so PostCard links to /profile/{orgId}
          // which /profile/[id].tsx redirects to /orgs/{orgId}.
          authorName = orgRecord.name;
          authorUsername = orgRecord.id;
          authorProfileImageUrl = orgRecord.imageUrl ?? null;
        } else if (authorUser) {
          authorName =
            authorUser.displayName ?? authorUser.username ?? post.authorId;
          authorUsername = authorUser.username;
          authorProfileImageUrl = authorUser.profileImageUrl;
        }

        // Build repost metadata the same way the main feed does so PostCard
        // can render repost cards with the original post's content.
        const isRepost = post.type === 'repost';
        const isQuote = isRepost && post.content !== '';
        const originalPostData = post.originalPostId
          ? (originalPostMap.get(post.originalPostId) ?? null)
          : null;
        let originalPost: NarrativePost['originalPost'] = null;
        if (originalPostData) {
          const origActor = StaticDataRegistry.getActor(
            originalPostData.authorId
          );
          const origOrg = origActor
            ? null
            : StaticDataRegistry.getOrganization(originalPostData.authorId);
          const origAuthorName =
            origActor?.name ??
            origOrg?.name ??
            originalPostData.displayName ??
            originalPostData.username ??
            originalPostData.authorId;
          originalPost = {
            id: originalPostData.id,
            content: originalPostData.content,
            authorId: originalPostData.authorId,
            authorName: origAuthorName,
            authorUsername:
              origActor?.username ??
              origOrg?.id ??
              originalPostData.username ??
              null,
            authorProfileImageUrl:
              origActor?.profileImageUrl ??
              origOrg?.imageUrl ??
              originalPostData.profileImageUrl ??
              null,
            timestamp: toISOStringStrict(
              originalPostData.timestamp,
              'timestamp',
              originalPostData.id
            ),
          };
        }

        const narrativePost: NarrativePost = {
          id: post.id,
          content: post.content,
          fullContent: post.fullContent ?? null,
          articleTitle: post.articleTitle ?? null,
          category: post.category ?? null,
          imageUrl: post.imageUrl ?? null,
          type: post.type,
          timestamp,
          authorId: post.authorId,
          authorName,
          authorUsername,
          authorProfileImageUrl,
          likeCount,
          commentCount,
          shareCount,
          isLiked: false,
          isShared: false,
          relatedQuestion: post.relatedQuestion ?? null,
          authorType,
          isRepost,
          isQuote,
          quoteComment: isQuote ? post.content : null,
          originalPostId: post.originalPostId ?? null,
          originalPost,
        };

        const storyKey =
          post.relatedQuestion != null
            ? String(post.relatedQuestion)
            : GENERAL_STORY_KEY;

        const bucket = storyPostMap.get(storyKey);
        if (bucket) {
          bucket.push(narrativePost);
        } else {
          storyPostMap.set(storyKey, [narrativePost]);
        }
      }

      // Score and sort stories
      const stories: NarrativeStory[] = [];

      for (const [storyKey, storyPosts] of storyPostMap) {
        // Sort posts newest first within each story
        storyPosts.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        const newestTimestamp = new Date(storyPosts[0]!.timestamp);
        const totalLikes = storyPosts.reduce((acc, p) => acc + p.likeCount, 0);
        const totalComments = storyPosts.reduce(
          (acc, p) => acc + p.commentCount,
          0
        );
        const totalShares = storyPosts.reduce(
          (acc, p) => acc + p.shareCount,
          0
        );
        const questionNumber =
          storyKey === GENERAL_STORY_KEY ? null : parseInt(storyKey, 10);
        const meta =
          questionNumber !== null ? questionMetaMap.get(questionNumber) : null;
        const storyTitle =
          meta?.title ??
          (questionNumber !== null ? `Story #${questionNumber}` : 'General');
        const arcState = meta?.arcState ?? null;

        // Skip resolved questions — no remaining tension
        if (meta?.status === 'resolved') continue;
        // Skip questions whose deadline has passed even if status hasn't updated yet
        if (meta?.resolutionDate && meta.resolutionDate <= now) continue;

        const baseScore = calculateStoryScore(
          totalLikes,
          totalComments,
          totalShares,
          storyPosts.length,
          newestTimestamp
        );
        const resolutionBoost = meta?.resolutionDate
          ? calculateResolutionBoost(meta.resolutionDate)
          : 1.0;
        const storyScoreValue =
          baseScore * calculateArcStateMultiplier(arcState) * resolutionBoost;

        stories.push({
          storyKey,
          storyTitle,
          questionNumber,
          arcState,
          storyScore: Math.round(storyScoreValue * 10000) / 10000,
          postCount: storyPosts.length,
          posts: storyPosts,
          hasUserPosition: false,
        });
      }

      // Dissolve the __general__ bucket into individual scored post cards.
      // Each top post competes on merit alongside question stories, creating
      // the "stories + hot + latest" blend instead of a single dump at the bottom.
      const generalPosts = storyPostMap.get(GENERAL_STORY_KEY) ?? [];
      const standalonePostCards = generalPosts
        .map((post) => ({
          post,
          score: calculateStoryScore(
            post.likeCount,
            post.commentCount,
            post.shareCount,
            1,
            new Date(post.timestamp)
          ),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_STANDALONE_POSTS)
        .filter(({ score }) => score >= MIN_STANDALONE_SCORE);

      for (const { post, score } of standalonePostCards) {
        // Use article headline when available; otherwise truncate the social content
        const rawTitle =
          post.articleTitle ??
          (post.content.length > 80
            ? post.content.slice(0, 80).replace(/\s+\S*$/, '') + '…'
            : post.content);

        stories.push({
          storyKey: `post:${post.id}`,
          storyTitle: rawTitle,
          questionNumber: null,
          arcState: null,
          storyScore: Math.round(score * 10000) / 10000,
          postCount: 1,
          posts: [post],
          hasUserPosition: false,
        });
      }

      // Resolve marketId for question-backed stories so the frontend can render
      // a live probability chart (PredictionSparkline) on each post card.
      // Same text-based join used for new market cards; this fetches only
      // existing stories (not new markets which already have marketId set).
      const storyQuestionNumbers = stories
        .filter((s) => !s.isNewMarket && s.questionNumber !== null)
        .map((s) => s.questionNumber as number);
      if (storyQuestionNumbers.length > 0) {
        const marketRows = await db
          .select({
            questionNumber: questions.questionNumber,
            marketId: markets.id,
          })
          .from(questions)
          .innerJoin(
            markets,
            sql`lower(trim(${markets.question})) = lower(trim(${questions.text}))`
          )
          .where(inArray(questions.questionNumber, storyQuestionNumbers))
          .orderBy(desc(markets.createdAt));
        const questionToMarket = new Map(
          dedupeQuestionMarketRows(marketRows).map((r) => [
            r.questionNumber,
            r.marketId,
          ])
        );
        for (const story of stories) {
          if (!story.isNewMarket && story.questionNumber !== null) {
            story.marketId = questionToMarket.get(story.questionNumber) ?? null;
          }
        }
      }

      // Sort all stories — question stories AND standalone posts — by score DESC.
      // Active question stories naturally float above standalone posts because
      // the arc state and resolution proximity multipliers boost their score.
      stories.sort(compareFeedStories);

      // Inject "New Market" cards for questions opened in the last 24h.
      // These appear even if the question has no posts yet, giving users a
      // chance to discover and trade on fresh markets directly from the feed.
      const existingQuestionNumbers = new Set(
        stories
          .map((s) => s.questionNumber)
          .filter((n): n is number => n !== null)
      );

      // Join markets on question text to get the market UUID (for deep-linking
      // to /markets/predictions/[id]) and live share counts (for probability bars).
      // LEFT JOIN since a question may not yet have a market entry.
      const newMarketRows = await db
        .select({
          questionNumber: questions.questionNumber,
          text: questions.text,
          resolutionDate: questions.resolutionDate,
          createdAt: questions.createdAt,
          arcState: arcStates.currentState,
          marketId: markets.id,
          yesShares: markets.yesShares,
          noShares: markets.noShares,
        })
        .from(questions)
        .leftJoin(arcStates, eq(arcStates.questionId, questions.id))
        // Match on normalized text (trim + lower) to survive minor whitespace
        // or casing differences. A proper questions.marketId FK would be better
        // and is tracked as a follow-up schema migration.
        .leftJoin(
          markets,
          sql`lower(trim(${markets.question})) = lower(trim(${questions.text}))`
        )
        .where(
          and(
            eq(questions.status, 'active'),
            gte(questions.createdAt, newMarketCutoff),
            lt(
              questions.resolutionDate,
              new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
            ), // resolves within 30 days
            // inArray requires a non-empty array. When no stories exist yet,
            // use [-1] as a sentinel (no valid questionNumber is ever -1) so
            // the NOT IN clause is always syntactically valid.
            not(
              inArray(
                questions.questionNumber,
                existingQuestionNumbers.size > 0
                  ? [...existingQuestionNumbers]
                  : [-1]
              )
            )
          )
        )
        .orderBy(desc(questions.createdAt), desc(markets.createdAt));

      // Dedupe before slicing so duplicate join rows cannot crowd out
      // later unique questions from the final feed payload.
      const newMarketQuestions = dedupeQuestionMarketRows(newMarketRows).slice(
        0,
        5
      );

      for (const q of newMarketQuestions) {
        // New market cards score on recency alone — they float near top on open day
        const hoursSinceOpen =
          (now.getTime() - q.createdAt.getTime()) / (1000 * 60 * 60);
        const recencyScore = Math.exp((-Math.LN2 * hoursSinceOpen) / 6); // 6h half-life
        const arcMultiplier = calculateArcStateMultiplier(
          (q.arcState as ArcStateType | null) ?? null
        );

        stories.push({
          storyKey: `market:${q.questionNumber}`,
          storyTitle: q.text,
          questionNumber: q.questionNumber,
          arcState: (q.arcState as ArcStateType | null) ?? null,
          storyScore: Math.round(recencyScore * arcMultiplier * 10000) / 10000,
          postCount: 0,
          posts: [],
          hasUserPosition: false,
          isNewMarket: true,
          resolutionDate: toISO(q.resolutionDate),
          marketId: q.marketId ?? null,
          yesShares: Number(q.yesShares ?? 0),
          noShares: Number(q.noShares ?? 0),
          // Anchor the InteractionBar on NewMarketCard to the first NPC post
          // about this question. Those posts are filtered from the feed body
          // (they duplicate the card), but their IDs let the card be likeable,
          // commentable, and shareable like any other post.
          anchorPostId:
            recentPosts.find((p) => p.relatedQuestion === q.questionNumber)
              ?.id ?? null,
        });
      }

      // Re-sort after injecting new market cards
      if (newMarketQuestions.length > 0) {
        stories.sort(compareFeedStories);
      }

      return { stories, postIds };
    },
    // 120s TTL — cache invalidation on new post creation (posts/route.ts) keeps
    // this fresh in practice; TTL is a safety net, not the freshness mechanism.
    { namespace: 'feed', ttl: 120 }
  );

  // Per-user enrichment — isLiked, isShared, hasUserPosition.
  // Results are cached per-user for USER_ENRICHMENT_TTL_S seconds to avoid
  // 3 DB round-trips × N concurrent authenticated users on every request.
  // On any Redis/cache error we degrade gracefully to the un-personalized feed
  // rather than surfacing a 500 to the user.
  let finalStories: NarrativeStory[] = result.stories;

  if (user?.userId) {
    const userId = user.userId;
    const questionNumbersInResult = result.stories
      .map((s) => s.questionNumber)
      .filter((n): n is number => n !== null);

    try {
      const enrichCacheKey = narrativeEnrichmentKey(userId);
      const cachedEnrichment = await getCache<UserEnrichmentCache>(
        enrichCacheKey,
        { namespace: 'feed' }
      );

      let enrichment: UserEnrichmentCache;

      if (cachedEnrichment) {
        enrichment = cachedEnrichment;
      } else {
        // Cache miss — fetch from DB in parallel and populate cache
        const [userLikes, userShares, userPositions] = await Promise.all([
          result.postIds.length > 0
            ? db
                .select({ postId: reactions.postId })
                .from(reactions)
                .where(
                  and(
                    inArray(reactions.postId, result.postIds),
                    eq(reactions.userId, userId),
                    eq(reactions.type, 'like')
                  )
                )
            : Promise.resolve([]),
          result.postIds.length > 0
            ? db
                .select({ postId: shares.postId })
                .from(shares)
                .where(
                  and(
                    inArray(shares.postId, result.postIds),
                    eq(shares.userId, userId)
                  )
                )
            : Promise.resolve([]),
          questionNumbersInResult.length > 0
            ? db
                .select({ questionId: positions.questionId })
                .from(positions)
                .where(
                  and(
                    eq(positions.userId, userId),
                    eq(positions.status, 'active'),
                    isNotNull(positions.questionId),
                    inArray(positions.questionId, questionNumbersInResult)
                  )
                )
            : Promise.resolve([]),
        ]);

        enrichment = {
          likedPostIds: userLikes
            .map((l) => l.postId)
            .filter((id): id is string => id !== null),
          sharedPostIds: userShares
            .map((s) => s.postId)
            .filter((id): id is string => id !== null),
          positionQuestionIds: userPositions
            .map((p) => p.questionId)
            .filter((id): id is number => id !== null),
        };

        // Cache write — errors logged but never block the response.
        // Note: enrichment is scoped to the current postIds set; if the feed
        // cache regenerates before this TTL expires, new posts will show
        // isLiked: false until the enrichment key expires (max 30s).
        setCache(enrichCacheKey, enrichment, {
          namespace: 'feed',
          ttl: USER_ENRICHMENT_TTL_S,
        }).catch((err) => {
          logger.error(
            'Failed to write enrichment cache',
            { error: err, userId, key: enrichCacheKey },
            'NarrativeFeedAPI'
          );
        });
      }

      const likedSet = new Set(enrichment.likedPostIds);
      const sharedSet = new Set(enrichment.sharedPostIds);
      const positionSet = new Set(enrichment.positionQuestionIds);

      finalStories = result.stories.map((story) => ({
        ...story,
        hasUserPosition:
          story.questionNumber !== null &&
          positionSet.has(story.questionNumber),
        posts: story.posts.map((post) => ({
          ...post,
          isLiked: likedSet.has(post.id),
          isShared: sharedSet.has(post.id),
        })),
      }));

      // Re-sort: stories with user positions first (within non-general tier),
      // then by score descending, general story always last.
      finalStories.sort((a, b) => {
        const aIsGeneral = a.questionNumber === null;
        const bIsGeneral = b.questionNumber === null;
        if (aIsGeneral !== bIsGeneral) return aIsGeneral ? 1 : -1;
        if (a.hasUserPosition !== b.hasUserPosition)
          return a.hasUserPosition ? -1 : 1;
        return b.storyScore - a.storyScore;
      });
    } catch (err) {
      // Redis unavailable or DB enrichment query failed — degrade to the
      // un-personalized base feed rather than returning HTTP 500.
      logger.error(
        'Enrichment failed — serving un-personalized feed',
        { error: err, userId },
        'NarrativeFeedAPI'
      );
    }
  }

  const response = successResponse({
    success: true,
    stories: finalStories,
    generatedAt: new Date().toISOString(),
  } satisfies NarrativeFeedResponse);

  if (rateLimitInfo) {
    if (user?.userId) {
      // Personalized response — must not be shared by CDN across users
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('X-RateLimit-Limit', rateLimitInfo.limit.toString());
      response.headers.set(
        'X-RateLimit-Remaining',
        rateLimitInfo.remaining.toString()
      );
      response.headers.set('X-RateLimit-Reset', toISO(rateLimitInfo.resetAt));
    } else {
      addPublicReadHeaders(response, rateLimitInfo);
    }
  }
  return response;
});
