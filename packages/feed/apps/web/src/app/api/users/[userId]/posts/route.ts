/**
 * User Posts API
 *
 * @route GET /api/users/[userId]/posts - Get user posts and replies
 * @access Public
 *
 * @description
 * Returns user's posts and comments/replies with interaction counts. Supports
 * filtering by type (posts or replies). Includes reposts/shares and excludes
 * future posts. Optimized with batch queries to prevent N+1 problems.
 *
 * @openapi
 * /api/users/{userId}/posts:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get user posts and replies
 *     description: Returns user's posts or replies with interaction counts and author information
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID, username, or wallet address
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [posts, replies]
 *           default: posts
 *         description: Type of content to retrieve
 *     responses:
 *       200:
 *         description: User posts/replies retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:
 *                   type: string
 *                   enum: [posts, replies]
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       content:
 *                         type: string
 *                       authorId:
 *                         type: string
 *                       timestamp:
 *                         type: string
 *                         format: date-time
 *                       likeCount:
 *                         type: integer
 *                       commentCount:
 *                         type: integer
 *                       shareCount:
 *                         type: integer
 *                       isLiked:
 *                         type: boolean
 *                       isShared:
 *                         type: boolean
 *                 total:
 *                   type: integer
 *
 * @example
 * ```typescript
 * // Get user posts
 * const posts = await fetch('/api/users/user_123/posts?type=posts');
 *
 * // Get user replies
 * const replies = await fetch('/api/users/user_123/posts?type=replies');
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import {
  addPublicReadHeaders,
  findUserByIdentifier,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  and,
  comments,
  count,
  db,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  posts,
  reactions,
  shares,
  users,
} from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import {
  logger,
  toISO,
  UserIdParamSchema,
  UserPostsQuerySchema,
} from "@feed/shared";
import type { NextRequest } from "next/server";

/**
 * GET /api/users/[userId]/posts
 * Get user's posts and comments/replies
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> },
  ) => {
    const { error, user, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;

    const params = await context.params;
    const { userId } = UserIdParamSchema.parse(params);
    const targetUser = await findUserByIdentifier(userId, { id: true });

    // If user doesn't exist yet (new Privy user), return empty data
    if (!targetUser) {
      logger.info(
        "User not found - returning empty data (may be new Privy user)",
        { userId },
        "GET /api/users/[userId]/posts",
      );
      const emptyRes = successResponse({
        items: [],
        total: 0,
        type: "posts",
      });
      if (rateLimitInfo) addPublicReadHeaders(emptyRes, rateLimitInfo);
      return emptyRes;
    }

    const canonicalUserId = targetUser.id;

    // Validate query parameters
    const { searchParams } = new URL(request.url);
    const queryParams = {
      type: searchParams.get("type") || "posts",
      page: searchParams.get("page") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    };
    const { type } = UserPostsQuerySchema.parse(queryParams);

    if (type === "replies") {
      // Get user's comments (replies)
      const userComments = await db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.authorId, canonicalUserId),
            isNull(comments.deletedAt),
          ),
        )
        .orderBy(desc(comments.createdAt))
        .limit(100);

      if (userComments.length === 0) {
        return successResponse({
          type: "replies",
          items: [],
          total: 0,
        });
      }

      const commentIds = userComments.map((c) => c.id);
      const postIds = [...new Set(userComments.map((c) => c.postId))];
      const parentCommentIds = [
        ...new Set(
          userComments
            .map((c) => c.parentCommentId)
            .filter((id): id is string => id !== null),
        ),
      ];

      // Fetch posts for these comments
      const postsData = await db
        .select({
          id: posts.id,
          content: posts.content,
          authorId: posts.authorId,
          timestamp: posts.timestamp,
        })
        .from(posts)
        .where(inArray(posts.id, postIds));

      const postsMap = new Map(postsData.map((p) => [p.id, p]));

      // Fetch parent comments (for replies to comments)
      let parentCommentsMap = new Map<
        string,
        {
          id: string;
          content: string;
          authorId: string;
          createdAt: Date;
        }
      >();
      if (parentCommentIds.length > 0) {
        const parentCommentsData = await db
          .select({
            id: comments.id,
            content: comments.content,
            authorId: comments.authorId,
            createdAt: comments.createdAt,
          })
          .from(comments)
          .where(
            and(
              inArray(comments.id, parentCommentIds),
              isNull(comments.deletedAt),
            ),
          );

        parentCommentsMap = new Map(parentCommentsData.map((c) => [c.id, c]));
      }

      // Fetch like counts for comments
      const likeCountsResult = await db
        .select({
          commentId: reactions.commentId,
          count: count(),
        })
        .from(reactions)
        .where(
          and(
            inArray(reactions.commentId, commentIds),
            eq(reactions.type, "like"),
          ),
        )
        .groupBy(reactions.commentId);

      const likeCountsMap = new Map(
        likeCountsResult.map((r) => [r.commentId, Number(r.count)]),
      );

      // Fetch reply counts for comments
      const replyCountsResult = await db
        .select({
          parentCommentId: comments.parentCommentId,
          count: count(),
        })
        .from(comments)
        .where(
          and(
            inArray(comments.parentCommentId, commentIds),
            isNull(comments.deletedAt),
          ),
        )
        .groupBy(comments.parentCommentId);

      const replyCountsMap = new Map(
        replyCountsResult.map((r) => [r.parentCommentId, Number(r.count)]),
      );

      // Check if user has liked comments
      let userLikesSet = new Set<string>();
      if (user) {
        const userLikes = await db
          .select({ commentId: reactions.commentId })
          .from(reactions)
          .where(
            and(
              inArray(reactions.commentId, commentIds),
              eq(reactions.userId, user.userId),
              eq(reactions.type, "like"),
            ),
          );
        userLikesSet = new Set(
          userLikes
            .map((l) => l.commentId)
            .filter((id): id is string => id !== null),
        );
      }

      // Fetch interaction counts for parent posts
      const [postLikeCounts, postCommentCounts, postShareCounts] =
        postIds.length > 0
          ? await Promise.all([
              db
                .select({
                  postId: reactions.postId,
                  count: count(),
                })
                .from(reactions)
                .where(
                  and(
                    inArray(reactions.postId, postIds),
                    eq(reactions.type, "like"),
                  ),
                )
                .groupBy(reactions.postId),
              db
                .select({
                  postId: comments.postId,
                  count: count(),
                })
                .from(comments)
                .where(
                  and(
                    inArray(comments.postId, postIds),
                    isNull(comments.deletedAt),
                  ),
                )
                .groupBy(comments.postId),
              db
                .select({
                  postId: shares.postId,
                  count: count(),
                })
                .from(shares)
                .where(inArray(shares.postId, postIds))
                .groupBy(shares.postId),
            ])
          : [[], [], []];

      const postLikeCountsMap = new Map(
        postLikeCounts.map((r) => [r.postId, Number(r.count)]),
      );
      const postCommentCountsMap = new Map(
        postCommentCounts.map((r) => [r.postId, Number(r.count)]),
      );
      const postShareCountsMap = new Map(
        postShareCounts.map((r) => [r.postId, Number(r.count)]),
      );

      // Fetch interaction counts for parent comments
      let parentCommentLikeCountsMap = new Map<string, number>();
      let parentCommentReplyCountsMap = new Map<string, number>();
      if (parentCommentIds.length > 0) {
        const [parentCommentLikeCounts, parentCommentReplyCounts] =
          await Promise.all([
            db
              .select({
                commentId: reactions.commentId,
                count: count(),
              })
              .from(reactions)
              .where(
                and(
                  inArray(reactions.commentId, parentCommentIds),
                  eq(reactions.type, "like"),
                ),
              )
              .groupBy(reactions.commentId),
            db
              .select({
                parentCommentId: comments.parentCommentId,
                count: count(),
              })
              .from(comments)
              .where(
                and(
                  inArray(comments.parentCommentId, parentCommentIds),
                  isNull(comments.deletedAt),
                ),
              )
              .groupBy(comments.parentCommentId),
          ]);

        parentCommentLikeCountsMap = new Map(
          parentCommentLikeCounts
            .filter(
              (r): r is typeof r & { commentId: string } =>
                r.commentId !== null,
            )
            .map((r) => [r.commentId, Number(r.count)]),
        );
        parentCommentReplyCountsMap = new Map(
          parentCommentReplyCounts
            .filter(
              (r): r is typeof r & { parentCommentId: string } =>
                r.parentCommentId !== null,
            )
            .map((r) => [r.parentCommentId, Number(r.count)]),
        );
      }

      // Fetch user's likes/shares on parent posts and parent comments
      let userPostLikesSet = new Set<string>();
      let userPostSharesSet = new Set<string>();
      let userParentCommentLikesSet = new Set<string>();
      if (user) {
        const [userPostLikes, userPostShares, userParentCommentLikes] =
          await Promise.all([
            postIds.length > 0
              ? db
                  .select({ postId: reactions.postId })
                  .from(reactions)
                  .where(
                    and(
                      inArray(reactions.postId, postIds),
                      eq(reactions.userId, user.userId),
                      eq(reactions.type, "like"),
                    ),
                  )
              : Promise.resolve([] as Array<{ postId: string | null }>),
            postIds.length > 0
              ? db
                  .select({ postId: shares.postId })
                  .from(shares)
                  .where(
                    and(
                      inArray(shares.postId, postIds),
                      eq(shares.userId, user.userId),
                    ),
                  )
              : Promise.resolve([] as Array<{ postId: string }>),
            parentCommentIds.length > 0
              ? db
                  .select({ commentId: reactions.commentId })
                  .from(reactions)
                  .where(
                    and(
                      inArray(reactions.commentId, parentCommentIds),
                      eq(reactions.userId, user.userId),
                      eq(reactions.type, "like"),
                    ),
                  )
              : Promise.resolve([] as Array<{ commentId: string | null }>),
          ]);

        userPostLikesSet = new Set(
          userPostLikes
            .map((l) => l.postId)
            .filter((id): id is string => id !== null),
        );
        userPostSharesSet = new Set(userPostShares.map((s) => s.postId));
        userParentCommentLikesSet = new Set(
          userParentCommentLikes
            .map((l) => l.commentId)
            .filter((id): id is string => id !== null),
        );
      }

      // Fetch author info for posts and parent comments
      const parentCommentAuthorIds = [
        ...new Set(
          Array.from(parentCommentsMap.values()).map((c) => c.authorId),
        ),
      ];
      const allAuthorIds = [
        ...new Set([
          ...postsData.map((p) => p.authorId),
          ...parentCommentAuthorIds,
        ]),
      ];
      const authorsUsers = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          username: users.username,
          profileImageUrl: users.profileImageUrl,
        })
        .from(users)
        .where(inArray(users.id, allAuthorIds));

      const userAuthorsMap = new Map(authorsUsers.map((u) => [u.id, u]));

      // Helper function to get author info (same pattern as comment API)
      // Check StaticDataRegistry first (for actors/orgs), then database
      const getAuthorInfo = (
        authorId: string,
      ): {
        id: string;
        displayName: string;
        username: string | null;
        profileImageUrl: string | null;
      } | null => {
        // Check if it's an actor (NPC/agent) - check FIRST like comment API
        const actor = StaticDataRegistry.getActor(authorId);
        if (actor) {
          return {
            id: actor.id,
            displayName: actor.name,
            username: null,
            profileImageUrl:
              actor.profileImageUrl || `/images/actors/${actor.id}.jpg`,
          };
        }
        // Check if it's an organization
        const org = StaticDataRegistry.getOrganization(authorId);
        if (org) {
          return {
            id: org.id,
            displayName: org.name,
            username: null,
            profileImageUrl:
              org.imageUrl || `/images/organizations/${org.id}.jpg`,
          };
        }
        // Fall back to database user lookup
        const dbUser = userAuthorsMap.get(authorId);
        if (dbUser) {
          return {
            id: dbUser.id,
            displayName: dbUser.displayName ?? dbUser.username ?? authorId,
            username: dbUser.username,
            profileImageUrl: dbUser.profileImageUrl,
          };
        }
        return null;
      };

      // Format comments as replies
      const replies = userComments.map((comment) => {
        const post = postsMap.get(comment.postId);

        // Get parent comment if this is a reply to a comment
        const parentComment = comment.parentCommentId
          ? parentCommentsMap.get(comment.parentCommentId)
          : null;

        return {
          id: comment.id,
          content: comment.content,
          postId: comment.postId,
          parentCommentId: comment.parentCommentId,
          createdAt: toISO(comment.createdAt),
          updatedAt: toISO(comment.updatedAt),
          likeCount: likeCountsMap.get(comment.id) ?? 0,
          replyCount: replyCountsMap.get(comment.id) ?? 0,
          isLiked: userLikesSet.has(comment.id),
          // Parent comment (if replying to a comment)
          parentComment: parentComment
            ? {
                id: parentComment.id,
                content: parentComment.content,
                authorId: parentComment.authorId,
                createdAt: toISO(parentComment.createdAt),
                author: getAuthorInfo(parentComment.authorId),
                likeCount:
                  parentCommentLikeCountsMap.get(parentComment.id) ?? 0,
                replyCount:
                  parentCommentReplyCountsMap.get(parentComment.id) ?? 0,
                isLiked: userParentCommentLikesSet.has(parentComment.id),
              }
            : null,
          // Original post (always included for context)
          post: post
            ? {
                id: post.id,
                content: post.content,
                authorId: post.authorId,
                timestamp: toISO(post.timestamp),
                author: getAuthorInfo(post.authorId),
                likeCount: postLikeCountsMap.get(post.id) ?? 0,
                commentCount: postCommentCountsMap.get(post.id) ?? 0,
                shareCount: postShareCountsMap.get(post.id) ?? 0,
                isLiked: userPostLikesSet.has(post.id),
                isShared: userPostSharesSet.has(post.id),
              }
            : null,
        };
      });

      logger.info(
        "User replies fetched successfully",
        { userId: canonicalUserId, total: replies.length },
        "GET /api/users/[userId]/posts",
      );

      return successResponse({
        type: "replies",
        items: replies,
        total: replies.length,
      });
    }
    // Get user's posts - filter out future posts
    const now = new Date();
    const userPosts = await db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.authorId, canonicalUserId),
          isNull(posts.deletedAt),
          lte(posts.timestamp, now),
        ),
      )
      .orderBy(desc(posts.timestamp))
      .limit(100);

    if (userPosts.length === 0) {
      return successResponse({
        type: "posts",
        items: [],
        total: 0,
      });
    }

    const postIds = userPosts.map((p) => p.id);

    // Fetch like counts
    const likeCountsResult = await db
      .select({
        postId: reactions.postId,
        count: count(),
      })
      .from(reactions)
      .where(
        and(inArray(reactions.postId, postIds), eq(reactions.type, "like")),
      )
      .groupBy(reactions.postId);

    const likeCountsMap = new Map(
      likeCountsResult.map((r) => [r.postId, Number(r.count)]),
    );

    // Fetch comment counts
    const commentCountsResult = await db
      .select({
        postId: comments.postId,
        count: count(),
      })
      .from(comments)
      .where(and(inArray(comments.postId, postIds), isNull(comments.deletedAt)))
      .groupBy(comments.postId);

    const commentCountsMap = new Map(
      commentCountsResult.map((r) => [r.postId, Number(r.count)]),
    );

    // Fetch share counts
    const shareCountsResult = await db
      .select({
        postId: shares.postId,
        count: count(),
      })
      .from(shares)
      .where(inArray(shares.postId, postIds))
      .groupBy(shares.postId);

    const shareCountsMap = new Map(
      shareCountsResult.map((r) => [r.postId, Number(r.count)]),
    );

    // Check if user has liked/shared posts
    let userLikesSet = new Set<string>();
    let userSharesSet = new Set<string>();
    if (user) {
      const [userLikes, userShares] = await Promise.all([
        db
          .select({ postId: reactions.postId })
          .from(reactions)
          .where(
            and(
              inArray(reactions.postId, postIds),
              eq(reactions.userId, user.userId),
              eq(reactions.type, "like"),
            ),
          ),
        db
          .select({ postId: shares.postId })
          .from(shares)
          .where(
            and(
              inArray(shares.postId, postIds),
              eq(shares.userId, user.userId),
            ),
          ),
      ]);
      userLikesSet = new Set(
        userLikes
          .map((l) => l.postId)
          .filter((id): id is string => id !== null),
      );
      userSharesSet = new Set(userShares.map((s) => s.postId));
    }

    // Fetch author info for the user (posts are all from userId)
    const [postAuthor] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        profileImageUrl: users.profileImageUrl,
      })
      .from(users)
      .where(eq(users.id, canonicalUserId))
      .limit(1);

    // Get original posts for reposts/quotes
    const originalPostIds = userPosts
      .filter((p) => p.originalPostId !== null)
      .map((p) => p.originalPostId)
      .filter((id): id is string => id !== null);

    let originalPostsMap = new Map<string, typeof posts.$inferSelect>();
    if (originalPostIds.length > 0) {
      const originalPosts = await db
        .select()
        .from(posts)
        .where(inArray(posts.id, originalPostIds));
      originalPostsMap = new Map(originalPosts.map((p) => [p.id, p]));
    }

    // Fetch author info for original posts
    const originalPostAuthorIds = [
      ...new Set(Array.from(originalPostsMap.values()).map((p) => p.authorId)),
    ];

    let originalUserAuthorsMap = new Map<
      string,
      {
        id: string;
        displayName: string | null;
        username: string | null;
        profileImageUrl: string | null;
      }
    >();
    let originalActorAuthorsMap = new Map<
      string,
      { id: string; name: string; profileImageUrl: string | null }
    >();
    let originalOrgAuthorsMap = new Map<
      string,
      { id: string; name: string; imageUrl: string | null }
    >();

    if (originalPostAuthorIds.length > 0) {
      const originalAuthorsUsers = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          username: users.username,
          profileImageUrl: users.profileImageUrl,
        })
        .from(users)
        .where(inArray(users.id, originalPostAuthorIds));

      originalUserAuthorsMap = new Map(
        originalAuthorsUsers.map((u) => [u.id, u]),
      );
      originalActorAuthorsMap = new Map(
        originalPostAuthorIds
          .map((id) => StaticDataRegistry.getActor(id))
          .filter((a): a is NonNullable<typeof a> => a !== null)
          .map((a) => [
            a.id,
            {
              id: a.id,
              name: a.name,
              profileImageUrl: a.profileImageUrl ?? null,
            },
          ]),
      );
      originalOrgAuthorsMap = new Map(
        originalPostAuthorIds
          .map((id) => StaticDataRegistry.getOrganization(id))
          .filter((o): o is NonNullable<typeof o> => o !== null)
          .map((o) => [
            o.id,
            { id: o.id, name: o.name, imageUrl: o.imageUrl ?? null },
          ]),
      );
    }

    // Get interaction counts for original posts (for reposts)
    let originalReactionMap = new Map<string, number>();
    let originalCommentMap = new Map<string, number>();
    let originalShareMap = new Map<string, number>();

    if (originalPostIds.length > 0) {
      const [originalPostReactions, originalPostComments, originalPostShares] =
        await Promise.all([
          db
            .select({
              postId: reactions.postId,
              count: count(),
            })
            .from(reactions)
            .where(
              and(
                inArray(reactions.postId, originalPostIds),
                eq(reactions.type, "like"),
              ),
            )
            .groupBy(reactions.postId),
          db
            .select({
              postId: comments.postId,
              count: count(),
            })
            .from(comments)
            .where(inArray(comments.postId, originalPostIds))
            .groupBy(comments.postId),
          db
            .select({
              postId: shares.postId,
              count: count(),
            })
            .from(shares)
            .where(inArray(shares.postId, originalPostIds))
            .groupBy(shares.postId),
        ]);

      originalReactionMap = new Map(
        originalPostReactions.map((r) => [r.postId!, Number(r.count)]),
      );
      originalCommentMap = new Map(
        originalPostComments.map((c) => [c.postId, Number(c.count)]),
      );
      originalShareMap = new Map(
        originalPostShares.map((s) => [s.postId, Number(s.count)]),
      );
    }

    // Filter out reposts where the original post is deleted
    const validPosts = userPosts.filter((post) => {
      if (post.originalPostId) {
        const originalPost = originalPostsMap.get(post.originalPostId);
        const hasOriginalPost = originalPost && !originalPost.deletedAt;
        const isQuote = post.content && post.content.length > 0;

        // For quote posts, keep them even if original is deleted (user has commentary)
        // For simple reposts, filter out if original is deleted
        if (isQuote) {
          return true;
        }
        return hasOriginalPost;
      }
      return true;
    });

    // Format posts (includes both regular posts and reposts/quotes)
    const formattedPosts = validPosts.map((post) => {
      const basePost = {
        id: post.id,
        content: post.content,
        authorId: post.authorId,
        timestamp: toISO(post.timestamp),
        createdAt: toISO(post.createdAt),
        likeCount: likeCountsMap.get(post.id) ?? 0,
        commentCount: commentCountsMap.get(post.id) ?? 0,
        shareCount: shareCountsMap.get(post.id) ?? 0,
        isLiked: userLikesSet.has(post.id),
        isShared: userSharesSet.has(post.id),
        author: postAuthor
          ? {
              id: postAuthor.id,
              displayName: postAuthor.displayName,
              username: postAuthor.username,
              profileImageUrl: postAuthor.profileImageUrl,
            }
          : null,
      };

      // Check if this is a repost/quote
      if (post.originalPostId) {
        const isQuote = post.content && post.content.length > 0;
        const originalPost = originalPostsMap.get(post.originalPostId);

        // If original post exists and is not deleted
        if (originalPost && !originalPost.deletedAt) {
          // Get original post author info
          const originalUser = originalUserAuthorsMap.get(
            originalPost.authorId,
          );
          const originalActor = originalActorAuthorsMap.get(
            originalPost.authorId,
          );
          const originalOrg = originalOrgAuthorsMap.get(originalPost.authorId);

          // For simple reposts (not quotes), use the original post's interaction counts
          // For quote posts, keep the quote post's interaction counts
          const interactionCounts = !isQuote
            ? {
                likeCount: originalReactionMap.get(originalPost.id) ?? 0,
                commentCount: originalCommentMap.get(originalPost.id) ?? 0,
                shareCount: originalShareMap.get(originalPost.id) ?? 0,
              }
            : {
                likeCount: basePost.likeCount,
                commentCount: basePost.commentCount,
                shareCount: basePost.shareCount,
              };

          return {
            ...basePost,
            ...interactionCounts,
            isRepost: true,
            isQuote,
            quoteComment: isQuote ? post.content : null,
            originalPostId: originalPost.id,
            originalPost: {
              id: originalPost.id,
              content: originalPost.content,
              authorId: originalPost.authorId,
              authorName:
                originalUser?.displayName ||
                originalActor?.name ||
                originalOrg?.name ||
                originalPost.authorId,
              authorUsername: originalUser?.username || null,
              authorProfileImageUrl:
                originalUser?.profileImageUrl ||
                originalActor?.profileImageUrl ||
                originalOrg?.imageUrl ||
                null,
              timestamp: toISO(originalPost.timestamp),
            },
          };
        }

        // If original post is deleted but this is a quote post, return with null originalPost
        if (isQuote) {
          return {
            ...basePost,
            isRepost: true,
            isQuote: true,
            quoteComment: post.content,
            originalPostId: post.originalPostId,
            originalPost: null,
          };
        }
      }

      return basePost;
    });

    // Sort by timestamp (posts already include reposts/quotes)
    const allItems = formattedPosts.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    logger.info(
      "User posts fetched successfully",
      { userId: canonicalUserId, total: allItems.length },
      "GET /api/users/[userId]/posts",
    );

    const res = successResponse({
      type: "posts",
      items: allItems,
      total: allItems.length,
    });
    if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
    return res;
  },
);
