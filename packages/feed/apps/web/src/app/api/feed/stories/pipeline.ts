/**
 * Stories Feed Pipeline
 *
 * Assembles and scores narrative stories with daily-topic boost.
 * Imported by the /api/feed/stories route (wiring layer).
 */
import {
  and,
  arcStates,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  markets,
  not,
  posts,
  questions,
  reactions,
  shares,
  sql,
  users,
} from '@babylon/db';
import {
  dailyTopicService,
  isTextOnTopic,
  StaticDataRegistry,
} from '@babylon/engine';
import type {
  ArcStateType,
  NarrativePost,
  NarrativeStory,
} from '@babylon/shared';
import { logger } from '@babylon/shared';
import { compareFeedStories } from '@/app/api/feed/feed-cursor';
import { spreadNewMarkets } from '@/app/api/feed/for-you/scoring';
import {
  calculateArcStateMultiplier,
  calculateResolutionBoost,
  calculateStoryScore,
} from '@/app/api/feed/narrative/scoring';
import { dedupeQuestionMarketRows } from '../questionMarketRows';

// Safety guard against runaway queries — NOT a content cap. The ranking
// pipeline scores, diversifies, and orders all candidates regardless.
const SAFETY_CANDIDATE_LIMIT = 5000;
const MAX_NEW_MARKET_CANDIDATES = 12;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const NEW_MARKET_WINDOW_MS = 24 * 60 * 60 * 1000;
const BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TOPIC_MATCH_MULTIPLIER = 2.0;
const GENERAL_STORY_KEY = '__general__';

function toISOStringStrict(
  date: Date | string | null | undefined,
  fieldName: string,
  postId: string
): string {
  if (date === null || date === undefined) {
    logger.warn(
      `Null/undefined ${fieldName} for post ${postId}`,
      { postId },
      'StoriesPipeline'
    );
    return new Date().toISOString();
  }
  if (date instanceof Date) {
    if (isNaN(date.getTime())) {
      logger.warn(
        `Invalid Date for ${fieldName} on post ${postId}`,
        { postId },
        'StoriesPipeline'
      );
      return new Date().toISOString();
    }
    return date.toISOString();
  }
  const parsed = new Date(date);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  logger.warn(
    `Unparseable ${fieldName} "${date}" for post ${postId}`,
    { postId },
    'StoriesPipeline'
  );
  return new Date().toISOString();
}

interface QuestionMeta {
  title: string;
  status: string;
  arcState: ArcStateType | null;
  resolutionDate: Date;
  topicKey: string | null;
}

export interface StoriesTopic {
  topicKey: string;
  topicLabel: string;
  summary: string;
}

export interface StoriesPipelineResult {
  stories: NarrativeStory[];
  postIds: string[];
  topic: StoriesTopic | null;
  anchorPostById: Record<string, NarrativePost>;
  generatedAt: string;
}

export async function buildStoriesFeed(): Promise<StoriesPipelineResult> {
  const todaysTopic = await dailyTopicService.getCurrentTopic().catch((err) => {
    logger.warn('Failed to get daily topic', { error: err }, 'StoriesPipeline');
    return null;
  });

  const now = new Date();
  const cutoff = new Date(now.getTime() - TWELVE_HOURS_MS);

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
    .limit(SAFETY_CANDIDATE_LIMIT);

  // ─── Topic-relevant backfill (12h → 7d) ─────────────────────────────────────
  // When fresh content is sparse, fill remaining capacity with older posts that
  // are relevant to today's daily topic. Two sources:
  //   1. Posts linked to questions sharing today's topicKey (DB join)
  //   2. Standalone posts whose text matches topic keywords (in-memory filter)
  // These go through the same scoring pipeline so freshness decay keeps them
  // below primary content naturally.
  const remainingCapacity = SAFETY_CANDIDATE_LIMIT - recentPosts.length;
  if (remainingCapacity > 0 && todaysTopic) {
    const backfillCutoff = new Date(now.getTime() - BACKFILL_WINDOW_MS);

    // Source 1: Posts linked to questions with today's topicKey
    const topicLinkedPosts = await db
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
      .innerJoin(questions, eq(posts.relatedQuestion, questions.questionNumber))
      .where(
        and(
          isNull(posts.deletedAt),
          gte(posts.timestamp, backfillCutoff),
          lt(posts.timestamp, cutoff),
          isNull(posts.commentOnPostId),
          isNull(posts.parentCommentId),
          eq(questions.topicKey, todaysTopic.topicKey)
        )
      )
      .orderBy(desc(posts.timestamp))
      .limit(remainingCapacity);

    const primaryPostIds = new Set(recentPosts.map((p) => p.id));
    for (const p of topicLinkedPosts) {
      if (!primaryPostIds.has(p.id)) {
        recentPosts.push(p);
        primaryPostIds.add(p.id);
      }
    }

    // Source 2: Standalone posts (no relatedQuestion) matching topic keywords
    const standaloneCapacity = SAFETY_CANDIDATE_LIMIT - recentPosts.length;
    if (standaloneCapacity > 0) {
      const standaloneCandidates = await db
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
            gte(posts.timestamp, backfillCutoff),
            lt(posts.timestamp, cutoff),
            isNull(posts.commentOnPostId),
            isNull(posts.parentCommentId),
            isNull(posts.relatedQuestion)
          )
        )
        .orderBy(desc(posts.timestamp))
        .limit(standaloneCapacity * 3);

      let added = 0;
      for (const p of standaloneCandidates) {
        if (added >= standaloneCapacity) break;
        if (primaryPostIds.has(p.id)) continue;
        if (!isTextOnTopic(p.content, todaysTopic)) continue;
        recentPosts.push(p);
        primaryPostIds.add(p.id);
        added++;
      }
    }
  }

  const topicMeta = todaysTopic
    ? {
        topicKey: todaysTopic.topicKey,
        topicLabel: todaysTopic.topicLabel,
        summary: todaysTopic.summary,
      }
    : null;

  if (recentPosts.length === 0) {
    return {
      stories: [],
      postIds: [],
      topic: topicMeta,
      anchorPostById: {},
      generatedAt: now.toISOString(),
    };
  }

  const postIds = recentPosts.map((p) => p.id);

  // Single CTE for all engagement counts — avoids N separate round-trips
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

  // Repost original posts for PostCard rendering
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
    const originalAuthorIds = [...new Set(originalRows.map((r) => r.authorId))];
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
    const originalUserMap = new Map(originalAuthorUsers.map((u) => [u.id, u]));
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

  // Question metadata — includes topicKey so we can apply topic boost
  const questionNumbers = [
    ...new Set(
      recentPosts
        .map((p) => p.relatedQuestion)
        .filter((q): q is number => q !== null && q !== undefined)
    ),
  ];
  const questionMetaMap = new Map<number, QuestionMeta>();
  if (questionNumbers.length > 0) {
    const rows = await db
      .select({
        questionNumber: questions.questionNumber,
        text: questions.text,
        status: questions.status,
        arcState: arcStates.currentState,
        resolutionDate: questions.resolutionDate,
        topicKey: questions.topicKey,
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
        topicKey: q.topicKey ?? null,
      })
    );
  }

  // Group posts into story buckets by relatedQuestion
  const storyPostMap = new Map<string, NarrativePost[]>();

  for (const post of recentPosts) {
    const likeCount = reactionMap.get(post.id) ?? 0;
    const commentCount = commentMap.get(post.id) ?? 0;
    const shareCount = shareMap.get(post.id) ?? 0;
    const timestamp = toISOStringStrict(post.timestamp, 'timestamp', post.id);

    const authorUser = userMap.get(post.authorId);
    const actorRecord = StaticDataRegistry.getActor(post.authorId);
    const orgRecord = actorRecord
      ? null
      : StaticDataRegistry.getOrganization(post.authorId);

    let authorName = post.authorId;
    let authorUsername: string | null = null;
    let authorProfileImageUrl: string | null = null;
    const authorType: 'actor' | 'news' | 'user' = actorRecord
      ? 'actor'
      : orgRecord
        ? 'news'
        : 'user';

    // Filter org "NEW MARKET:" announcements — NewMarketCard is the canonical surface
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
      authorName = orgRecord.name;
      authorUsername = orgRecord.id;
      authorProfileImageUrl = orgRecord.imageUrl ?? null;
    } else if (authorUser) {
      authorName =
        authorUser.displayName ?? authorUser.username ?? post.authorId;
      authorUsername = authorUser.username;
      authorProfileImageUrl = authorUser.profileImageUrl;
    }

    const isRepost = post.type === 'repost';
    const isQuote = isRepost && post.content !== '';
    const originalPostData = post.originalPostId
      ? (originalPostMap.get(post.originalPostId) ?? null)
      : null;
    let originalPost: NarrativePost['originalPost'] = null;
    if (originalPostData) {
      const origActor = StaticDataRegistry.getActor(originalPostData.authorId);
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

  const todaysTopicKey = todaysTopic?.topicKey ?? null;
  const todaysTopicLabel = todaysTopic?.topicLabel ?? null;
  const stories: NarrativeStory[] = [];

  for (const [storyKey, storyPosts] of storyPostMap) {
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
    const totalShares = storyPosts.reduce((acc, p) => acc + p.shareCount, 0);
    const questionNumber =
      storyKey === GENERAL_STORY_KEY ? null : parseInt(storyKey, 10);
    const meta =
      questionNumber !== null ? questionMetaMap.get(questionNumber) : null;
    const storyTitle =
      meta?.title ??
      (questionNumber !== null ? `Story #${questionNumber}` : 'General');
    const arcState = meta?.arcState ?? null;
    const storyTopicKey = meta?.topicKey ?? null;

    // Skip resolved or expired questions
    if (meta?.status === 'resolved') continue;
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
    // Stories on today's topic float to the top of the feed
    const topicBoost =
      todaysTopicKey && storyTopicKey === todaysTopicKey
        ? TOPIC_MATCH_MULTIPLIER
        : 1.0;
    const storyScoreValue =
      baseScore *
      calculateArcStateMultiplier(arcState) *
      resolutionBoost *
      topicBoost;

    stories.push({
      storyKey,
      storyTitle,
      questionNumber,
      arcState,
      storyScore: Math.round(storyScoreValue * 10000) / 10000,
      postCount: storyPosts.length,
      posts: storyPosts,
      hasUserPosition: false,
      topicKey: storyTopicKey,
      topicLabel: storyTopicKey === todaysTopicKey ? todaysTopicLabel : null,
    });
  }

  // Standalone general posts compete on score alongside question stories
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
    .sort((a, b) => b.score - a.score);

  for (const { post, score } of standalonePostCards) {
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

  // Resolve marketId for question-backed stories (enables PredictionSparkline)
  const storyQuestionNumbers = stories
    .filter((s) => s.questionNumber !== null)
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
      if (story.questionNumber !== null) {
        story.marketId = questionToMarket.get(story.questionNumber) ?? null;
      }
    }
  }

  // ─── New market cards ──────────────────────────────────────────────────────
  // Port from the For You pipeline: inject isNewMarket story entries for
  // recently created markets that don't already have a story in the feed.
  const newMarketCutoff = new Date(now.getTime() - NEW_MARKET_WINDOW_MS);
  const anchorPostById: Record<string, NarrativePost> = {};
  const existingQuestionNumbers = new Set(
    stories
      .map((s) => s.questionNumber)
      .filter((qn): qn is number => qn !== null)
  );

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
      topicKey: questions.topicKey,
      topicLabel: questions.topicLabel,
    })
    .from(questions)
    .leftJoin(arcStates, eq(arcStates.questionId, questions.id))
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
        ),
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

  // Dedupe before slicing so duplicate join rows cannot crowd out later
  // unique questions from the surfaced new-market set.
  const newMarketQuestions = dedupeQuestionMarketRows(newMarketRows).slice(
    0,
    MAX_NEW_MARKET_CANDIDATES
  );

  for (const question of newMarketQuestions) {
    const hoursSinceOpen =
      (now.getTime() - question.createdAt.getTime()) / (1000 * 60 * 60);
    const recencyScore = Math.exp((-Math.LN2 * hoursSinceOpen) / 6);
    const arcMultiplier = calculateArcStateMultiplier(
      (question.arcState as ArcStateType | null) ?? null
    );
    const topicBoost =
      todaysTopicKey && question.topicKey === todaysTopicKey
        ? TOPIC_MATCH_MULTIPLIER
        : 1.0;

    // Track the NPC "NEW MARKET:" anchor post for InteractionBar hydration
    const anchorPost = recentPosts.find(
      (p) => p.relatedQuestion === question.questionNumber
    );
    let anchorPostId: string | null = null;
    if (anchorPost) {
      const anchorUser = userMap.get(anchorPost.authorId);
      const anchorActor = StaticDataRegistry.getActor(anchorPost.authorId);
      const anchorOrg = anchorActor
        ? null
        : StaticDataRegistry.getOrganization(anchorPost.authorId);
      const anchorNarrative: NarrativePost = {
        id: anchorPost.id,
        content: anchorPost.content,
        fullContent: anchorPost.fullContent ?? null,
        articleTitle: anchorPost.articleTitle ?? null,
        category: anchorPost.category ?? null,
        imageUrl: anchorPost.imageUrl ?? null,
        type: anchorPost.type,
        timestamp: toISOStringStrict(
          anchorPost.timestamp,
          'timestamp',
          anchorPost.id
        ),
        authorId: anchorPost.authorId,
        authorName:
          anchorActor?.name ??
          anchorOrg?.name ??
          anchorUser?.displayName ??
          anchorUser?.username ??
          anchorPost.authorId,
        authorUsername:
          anchorActor?.username ??
          anchorOrg?.id ??
          anchorUser?.username ??
          null,
        authorProfileImageUrl:
          anchorActor?.profileImageUrl ??
          anchorOrg?.imageUrl ??
          anchorUser?.profileImageUrl ??
          null,
        likeCount: reactionMap.get(anchorPost.id) ?? 0,
        commentCount: commentMap.get(anchorPost.id) ?? 0,
        shareCount: shareMap.get(anchorPost.id) ?? 0,
        isLiked: false,
        isShared: false,
        relatedQuestion: anchorPost.relatedQuestion ?? null,
        authorType: anchorActor ? 'actor' : anchorOrg ? 'news' : 'user',
      };
      anchorPostById[anchorPost.id] = anchorNarrative;
      anchorPostId = anchorPost.id;
    }

    stories.push({
      storyKey: `market:${question.questionNumber}`,
      storyTitle: question.text,
      questionNumber: question.questionNumber,
      arcState: (question.arcState as ArcStateType | null) ?? null,
      storyScore:
        Math.round(recencyScore * arcMultiplier * topicBoost * 10000) / 10000,
      postCount: anchorPostId ? 1 : 0,
      posts: anchorPostId ? [anchorPostById[anchorPostId]!] : [],
      hasUserPosition: false,
      isNewMarket: true,
      resolutionDate: question.resolutionDate.toISOString(),
      marketId: question.marketId ?? null,
      rootMarketId: question.marketId ?? null,
      yesShares: Number(question.yesShares ?? 0),
      noShares: Number(question.noShares ?? 0),
      anchorPostId,
      topicKey: question.topicKey ?? null,
      topicLabel: question.topicLabel ?? null,
      itemType: 'market',
      clusterId: question.marketId ?? `market:${question.questionNumber}`,
    });
  }

  // Final sort then ensure no adjacent market cards
  stories.sort(compareFeedStories);
  const distributedStories = spreadNewMarkets(stories);

  const allPostIds = [
    ...new Set(distributedStories.flatMap((s) => s.posts.map((p) => p.id))),
  ];

  return {
    stories: distributedStories,
    postIds: allPostIds,
    topic: topicMeta,
    anchorPostById,
    generatedAt: now.toISOString(),
  };
}

/** Mutates stories in-place with per-user like/share state. Bypasses the shared cache. */
export async function enrichStoriesForUser(
  stories: NarrativeStory[],
  postIds: string[],
  userId: string
): Promise<void> {
  const [userLikes, userShares] = await Promise.all([
    db
      .select({ postId: reactions.postId })
      .from(reactions)
      .where(
        and(
          inArray(reactions.postId, postIds),
          eq(reactions.userId, userId),
          eq(reactions.type, 'like')
        )
      ),
    db
      .select({ postId: shares.postId })
      .from(shares)
      .where(and(inArray(shares.postId, postIds), eq(shares.userId, userId))),
  ]);
  const likedPostIds = new Set(userLikes.map((l) => l.postId));
  const sharedPostIds = new Set(userShares.map((s) => s.postId));
  for (const story of stories) {
    for (const post of story.posts) {
      post.isLiked = likedPostIds.has(post.id);
      post.isShared = sharedPostIds.has(post.id);
    }
  }
}
