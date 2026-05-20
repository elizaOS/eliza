import { and, db, gte, isNull, lt, posts, sql } from '@babylon/db';

export interface ForYouCandidatePost {
  id: string;
  content: string;
  authorId: string;
  timestamp: Date;
  /** Matches `Post.type` (Drizzle column is `notNull().default('post')`). */
  type: string;
  articleTitle: string | null;
  fullContent: string | null;
  category: string | null;
  imageUrl: string | null;
  relatedQuestion: number | null;
  originalPostId: string | null;
}

const forYouCandidatePostSelection = {
  id: posts.id,
  content: posts.content,
  authorId: posts.authorId,
  timestamp: posts.timestamp,
  type: sql<string>`coalesce(${posts.type}, 'post')`,
  articleTitle: posts.articleTitle,
  fullContent: posts.fullContent,
  category: posts.category,
  imageUrl: posts.imageUrl,
  relatedQuestion: posts.relatedQuestion,
  originalPostId: posts.originalPostId,
};

const liveEngagementOrder = sql`
  (
    (SELECT COUNT(*)
     FROM "Reaction" r
     WHERE r."postId" = ${posts.id}
       AND r.type = 'like') +
    (SELECT COUNT(*)
     FROM "Comment" c
     WHERE c."postId" = ${posts.id}
       AND c."deletedAt" IS NULL) * 2 +
    (SELECT COUNT(*)
     FROM "Share" s
     WHERE s."postId" = ${posts.id}) * 3
  ) DESC
`;

async function loadForYouEngagementRankedPosts(
  windowStart: Date,
  windowEnd: Date,
  limit: number
): Promise<ForYouCandidatePost[]> {
  if (limit <= 0) {
    return [];
  }

  const rankedPostsWhere = and(
    isNull(posts.deletedAt),
    gte(posts.timestamp, windowStart),
    lt(posts.timestamp, windowEnd),
    isNull(posts.commentOnPostId),
    isNull(posts.parentCommentId)
  );

  return db
    .select(forYouCandidatePostSelection)
    .from(posts)
    .where(rankedPostsWhere)
    .orderBy(liveEngagementOrder)
    .limit(limit);
}

export async function loadHistoricalForYouBackfillPosts(
  backfillCutoff: Date,
  cutoff: Date,
  backfillCapacity: number
): Promise<ForYouCandidatePost[]> {
  return loadForYouEngagementRankedPosts(
    backfillCutoff,
    cutoff,
    backfillCapacity
  );
}

export async function loadDiscoveryForYouCandidatePosts(
  discoveryStart: Date,
  backfillEnd: Date,
  discoveryLimit: number
): Promise<ForYouCandidatePost[]> {
  return loadForYouEngagementRankedPosts(
    discoveryStart,
    backfillEnd,
    discoveryLimit
  );
}
