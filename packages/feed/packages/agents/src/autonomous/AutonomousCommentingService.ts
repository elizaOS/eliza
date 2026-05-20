/**
 * Autonomous Commenting Service
 *
 * Handles agents commenting on posts autonomously.
 * Uses LLM to intelligently select which post to comment on based on:
 * - Agent's trading positions and strategy
 * - Post relevance to agent's expertise
 * - Existing comment threads
 */

import { countTokensSync, truncateToTokenLimitSync } from '@babylon/api';
import {
  and,
  comments,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  perpPositions,
  positions,
  posts,
  reactions,
  users,
} from '@babylon/db';
import { StaticDataRegistry } from '@babylon/engine';
import type { IAgentRuntime } from '@elizaos/core';
import { parseKeyValueXml } from '@elizaos/core';
import { callGroqDirect } from '../llm/direct-groq';
import { agentService } from '../services/AgentService';
import { getAgentConfig } from '../shared/agent-config';
import { logger } from '../shared/logger';
import { getAgentContext } from './agent-context';
import { executeDirectComment } from './DirectExecutors';

// Max characters for comment content in prompts
const MAX_COMMENT_CHARS = 200;
// Max thread depth to walk up when building context
const MAX_THREAD_DEPTH = 5;

interface ThreadMessage {
  id: string;
  authorName: string;
  content: string;
  depth: number;
}

interface CommentThread {
  targetCommentId: string; // The comment to potentially reply to
  thread: ThreadMessage[]; // Conversation path from root to target
  likeCount: number;
}

interface PostWithComments {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: Date;
  commentCount: number;
  commentThreads: CommentThread[]; // Threads built from bottom up
}

export class AutonomousCommentingService {
  /**
   * Find relevant posts and create comments using LLM evaluation
   *
   * Supports both USER_CONTROLLED agents (User table) and NPCs (StaticDataRegistry)
   */
  async createAgentComment(
    agentUserId: string,
    _runtime: IAgentRuntime
  ): Promise<string | null> {
    // Resolve agent context (NPC vs USER_CONTROLLED)
    const { displayName: agentDisplayName } =
      await getAgentContext(agentUserId);

    const now = new Date();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Get posts agent already commented on
    const agentComments = await db
      .select({ postId: comments.postId })
      .from(comments)
      .where(eq(comments.authorId, agentUserId));

    const commentedPostIds = new Set(
      agentComments.map((c) => c.postId).filter((id) => id !== null) as string[]
    );

    // Get recent posts with author info
    const recentPostsRaw = await db
      .select({
        id: posts.id,
        content: posts.content,
        authorId: posts.authorId,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(
        and(
          ne(posts.authorId, agentUserId),
          isNull(posts.deletedAt),
          gte(posts.timestamp, oneDayAgo),
          lte(posts.timestamp, now)
        )
      )
      .orderBy(desc(posts.createdAt))
      .limit(15);

    // Filter to posts agent hasn't commented on
    const uncommentedPosts = recentPostsRaw.filter(
      (p) => !commentedPostIds.has(p.id)
    );

    if (uncommentedPosts.length === 0) {
      logger.info(
        `No uncommented posts for agent ${agentDisplayName}`,
        undefined,
        'AutonomousCommenting'
      );
      return null;
    }

    // Get comments for these posts (including parentCommentId for threading)
    const postIds = uncommentedPosts.map((p) => p.id);
    const allComments = await db
      .select({
        id: comments.id,
        content: comments.content,
        postId: comments.postId,
        authorId: comments.authorId,
        parentCommentId: comments.parentCommentId,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .where(isNull(comments.deletedAt))
      .orderBy(desc(comments.createdAt))
      .limit(200); // Increased to capture more thread context

    // Filter comments to our posts
    const postComments = allComments.filter(
      (c) => c.postId && postIds.includes(c.postId)
    );

    // Get like counts for these comments
    const commentIds = postComments.map((c) => c.id);
    const likeCountsRaw = await db
      .select({
        commentId: reactions.commentId,
      })
      .from(reactions)
      .where(and(eq(reactions.type, 'like')));

    // Count likes per comment (filter in memory since inArray might not work)
    const likeCounts = new Map<string, number>();
    for (const r of likeCountsRaw) {
      if (r.commentId && commentIds.includes(r.commentId)) {
        likeCounts.set(r.commentId, (likeCounts.get(r.commentId) || 0) + 1);
      }
    }

    // Add like counts to comments and sort by popularity
    const postCommentsWithLikes = postComments
      .map((c) => ({
        ...c,
        likeCount: likeCounts.get(c.id) || 0,
      }))
      .sort((a, b) => b.likeCount - a.likeCount);

    // Get author names for posts and comments
    const authorIds = [
      ...new Set([
        ...uncommentedPosts.map((p) => p.authorId),
        ...postComments.map((c) => c.authorId),
      ]),
    ];

    // First check StaticDataRegistry for actors/organizations
    const authorMap = new Map<string, string>();
    const missingAuthorIds: string[] = [];

    for (const authorId of authorIds) {
      const actor = StaticDataRegistry.getActor(authorId);
      if (actor) {
        authorMap.set(authorId, actor.name);
        continue;
      }
      const org = StaticDataRegistry.getOrganization(authorId);
      if (org) {
        authorMap.set(authorId, org.name);
        continue;
      }
      missingAuthorIds.push(authorId);
    }

    // Fetch remaining authors from database
    if (missingAuthorIds.length > 0) {
      const authorUsers = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          username: users.username,
        })
        .from(users)
        .where(inArray(users.id, missingAuthorIds));

      for (const u of authorUsers) {
        authorMap.set(u.id, u.displayName || u.username || 'User');
      }
    }

    // Helper: Build thread from bottom by walking UP from target comment
    const buildThreadFromBottom = (
      targetComment: (typeof postCommentsWithLikes)[0],
      commentMap: Map<string, (typeof postCommentsWithLikes)[0]>
    ): ThreadMessage[] => {
      const chain: (typeof postCommentsWithLikes)[0][] = [targetComment];
      let currentParentId = targetComment.parentCommentId;

      // Walk UP the parent chain
      while (currentParentId && chain.length < MAX_THREAD_DEPTH) {
        const parent = commentMap.get(currentParentId);
        if (!parent) break;
        chain.unshift(parent); // prepend = oldest first
        currentParentId = parent.parentCommentId;
      }

      return chain.map((c, i) => ({
        id: c.id,
        authorName: authorMap.get(c.authorId) || 'User',
        content: c.content,
        depth: i,
      }));
    };

    // Build thread structure for each post (from bottom up)
    const buildCommentThreads = (
      postId: string
    ): { commentThreads: CommentThread[]; totalCount: number } => {
      const postCommentsList = postCommentsWithLikes.filter(
        (c) => c.postId === postId
      );
      const totalCount = postCommentsList.length;

      if (totalCount === 0) {
        return { commentThreads: [], totalCount: 0 };
      }

      // Create a map of comments by ID
      const commentMap = new Map(postCommentsList.map((c) => [c.id, c]));

      // Find which comments have replies (children)
      const hasReplies = new Set<string>();
      for (const c of postCommentsList) {
        if (c.parentCommentId) {
          hasReplies.add(c.parentCommentId);
        }
      }

      // Identify "interesting" comments to show threads for:
      // 1. Leaf comments (no replies) - end of conversation
      // 2. Top-level comments with high engagement
      // Sort by: leaf status, then popularity
      const candidateComments = postCommentsList
        .map((c) => ({
          ...c,
          isLeaf: !hasReplies.has(c.id),
        }))
        .sort((a, b) => {
          // Prioritize leaf comments, then by likes
          if (a.isLeaf !== b.isLeaf) return a.isLeaf ? -1 : 1;
          return b.likeCount - a.likeCount;
        });

      // Build threads for top 5 candidate comments
      const commentThreads: CommentThread[] = [];
      const seenCommentIds = new Set<string>(); // Track all comments we've shown

      for (const candidate of candidateComments.slice(0, 8)) {
        // Skip if we've already shown this comment in another thread
        if (seenCommentIds.has(candidate.id)) {
          continue;
        }

        const thread = buildThreadFromBottom(candidate, commentMap);

        // Skip if any comment in this thread was already shown
        const hasOverlap = thread.some((msg) => seenCommentIds.has(msg.id));
        if (hasOverlap) {
          continue;
        }

        // Mark all comments in this thread as seen
        for (const msg of thread) {
          seenCommentIds.add(msg.id);
        }

        commentThreads.push({
          targetCommentId: candidate.id,
          thread,
          likeCount: candidate.likeCount,
        });

        if (commentThreads.length >= 5) break;
      }

      return { commentThreads, totalCount };
    };

    // Build posts with threaded comments (built from bottom up)
    const postsWithComments: PostWithComments[] = uncommentedPosts
      .slice(0, 8)
      .map((post) => {
        const { commentThreads, totalCount } = buildCommentThreads(post.id);

        return {
          id: post.id,
          content: post.content,
          authorId: post.authorId,
          authorName: authorMap.get(post.authorId) || 'User',
          createdAt: post.createdAt,
          commentCount: totalCount,
          commentThreads,
        };
      });

    if (postsWithComments.length === 0) {
      return null;
    }

    // Get agent's trading context
    const agentPositions = await db
      .select()
      .from(positions)
      .where(
        and(eq(positions.userId, agentUserId), eq(positions.status, 'active'))
      )
      .limit(5);

    const agentPerpPositions = await db
      .select()
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, agentUserId),
          isNull(perpPositions.closedAt)
        )
      )
      .limit(5);

    const config = await getAgentConfig(agentUserId);

    // Helper to format a comment thread (built from bottom, shows conversation path)
    const formatCommentThread = (commentThread: CommentThread): string => {
      const { thread } = commentThread;

      const threadLines = thread.map((msg, idx) => {
        const depthLabel = idx === 0 ? 'Comment' : `Reply (depth ${msg.depth})`;
        const truncatedContent =
          msg.content.substring(0, MAX_COMMENT_CHARS) +
          (msg.content.length > MAX_COMMENT_CHARS ? '...' : '');

        return `    - ${depthLabel} [comment_id: ${msg.id}] @${msg.authorName}: "${truncatedContent}"`;
      });

      return threadLines.join('\n');
    };

    // Build the evaluation prompt
    const postsContext = postsWithComments
      .map((post, idx) => {
        const threadsText =
          post.commentThreads.length > 0
            ? `\n  Conversation threads:\n${post.commentThreads.map((ct) => formatCommentThread(ct)).join('\n\n')}`
            : '\n  No comments yet';

        return `[${idx + 1}] Post by @${post.authorName}:
"${post.content.substring(0, 300)}${post.content.length > 300 ? '...' : ''}"
  (${post.commentCount} comments)${threadsText}`;
      })
      .join('\n\n');

    const tradingContext = [
      agentPositions.length > 0
        ? `Prediction positions: ${agentPositions.map((p) => `${p.side ? 'YES' : 'NO'} on market ${p.marketId}`).join(', ')}`
        : 'No prediction positions',
      agentPerpPositions.length > 0
        ? `Perp positions: ${agentPerpPositions.map((p) => `${p.side} ${p.ticker}`).join(', ')}`
        : 'No perp positions',
    ].join('\n');

    const prompt = `CRITICAL: Your response MUST start with <response> immediately. No <think> tags. No reasoning. Output only the XML.

${config?.systemPrompt ?? 'You are an AI agent on Babylon.'}

You are ${agentDisplayName}, an AI agent on Babylon.

Your trading context:
${tradingContext}
Strategy: ${config?.tradingStrategy || 'General market analysis'}

Available posts to engage with:

${postsContext}

Task: Decide which post (if any) to comment on, and whether to reply to an existing comment or comment directly on the post.

DECISION CRITERIA:
- Relevance: Does this post relate to your trading positions or expertise?
- Value: Can you add genuine insight, not just agreement?
- Engagement: Are there interesting threads to join?
- Avoid: Posts where you have nothing meaningful to add

CONTENT RULES:
- If mentioning prediction markets, use SHORT SUMMARIES not full questions
- ❌ BAD: "the 'Will TeslAI achieve full self-driving readiness by Q1 2025?' prediction"
- ✅ GOOD: "the TeslAI readiness bet" or "the BitcAIn drop prediction"

IMPORTANT THREADING RULE:
- If you want to respond to/agree with/reference another user's comment, you MUST use reply_to_comment_id to reply to their comment
- Do NOT make a top-level comment that mentions another commenter - that creates duplicate threads
- Only leave reply_to_comment_id empty if your comment is a NEW perspective on the post itself

OUTPUT FORMAT:
If commenting directly on a post:
<response>
<action>comment</action>
<post_index>1-${postsWithComments.length}</post_index>
<reply_to_comment_id></reply_to_comment_id>
<content>Your comment here (1-2 sentences, under ${MAX_COMMENT_CHARS} chars)</content>
</response>

If replying to an existing comment (use the comment_id shown in brackets):
<response>
<action>comment</action>
<post_index>1-${postsWithComments.length}</post_index>
<reply_to_comment_id>the_comment_id_from_brackets</reply_to_comment_id>
<content>Your reply here (1-2 sentences, under ${MAX_COMMENT_CHARS} chars)</content>
</response>

If you want to skip (no relevant posts):
<response>
<action>skip</action>
<reason>Brief reason</reason>
</response>`;

    // Ensure prompt fits within context limit
    const estimatedTokens = countTokensSync(prompt);
    let finalPrompt = prompt;

    if (estimatedTokens > 30000) {
      const truncated = truncateToTokenLimitSync(prompt, 30000, {
        ellipsis: true,
      });
      finalPrompt = truncated.text;
    }

    // Call LLM for decision
    const MAX_ATTEMPTS = 3;
    let decision: {
      action: string;
      postIndex?: number;
      replyToCommentId?: string;
      content?: string;
      reason?: string;
    } | null = null;
    let llmCompletion: string | null = null;
    let usedPrompt: string | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const isRetry = attempt > 1;
      const currentPrompt = isRetry
        ? `${finalPrompt}\n\nREMINDER: No <think> tags. Start DIRECTLY with <response>. Output only valid XML.`
        : finalPrompt;

      const responseText = await Promise.race([
        callGroqDirect({
          prompt: currentPrompt,
          system: config?.systemPrompt ?? undefined,
          modelSize: 'large',
          runtime: _runtime,
          temperature: isRetry ? 0.5 : 0.7,
          maxTokens: 16384,
          actionType: 'evaluate_comment_opportunity',
          purpose: 'evaluation',
        }),
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error('Timeout')), 20000);
        }),
      ]);

      // Extract response block
      const responseMatch = responseText.match(
        /<response>([\s\S]*?)<\/response>/i
      );
      if (!responseMatch) {
        logger.warn(
          'No <response> block found in comment evaluation',
          { attempt, raw: responseText.substring(0, 200) },
          'AutonomousCommenting'
        );
        continue;
      }

      const parsed = parseKeyValueXml(responseMatch[0]) as {
        action?: string;
        post_index?: string;
        reply_to_comment_id?: string;
        content?: string;
        reason?: string;
      } | null;

      if (!parsed?.action) {
        continue;
      }

      decision = {
        action: parsed.action,
        postIndex: parsed.post_index
          ? parseInt(parsed.post_index, 10)
          : undefined,
        replyToCommentId: parsed.reply_to_comment_id || undefined,
        content: parsed.content,
        reason: parsed.reason,
      };
      llmCompletion = responseText;
      usedPrompt = currentPrompt;
      break;
    }

    if (!decision) {
      logger.warn(
        'Failed to get comment decision from LLM',
        { agentUserId },
        'AutonomousCommenting'
      );
      return null;
    }

    // Handle skip
    if (decision.action === 'skip') {
      logger.info(
        `Agent ${agentDisplayName} decided to skip commenting: ${decision.reason}`,
        undefined,
        'AutonomousCommenting'
      );
      return null;
    }

    // Handle comment
    if (
      decision.action === 'comment' &&
      decision.postIndex &&
      decision.content
    ) {
      const selectedPost = postsWithComments[decision.postIndex - 1];
      if (!selectedPost) {
        logger.warn(
          `Invalid post index: ${decision.postIndex}`,
          { agentUserId },
          'AutonomousCommenting'
        );
        return null;
      }

      const cleanContent = decision.content.trim().replace(/^["']|["']$/g, '');
      if (!cleanContent || cleanContent.length < 5) {
        return null;
      }

      // Validate reply_to_comment_id if provided
      // Collect all comment IDs from comment threads
      const allCommentIds = selectedPost.commentThreads.flatMap((ct) =>
        ct.thread.map((msg) => msg.id)
      );

      let parentCommentId: string | null = null;
      if (decision.replyToCommentId) {
        if (allCommentIds.includes(decision.replyToCommentId)) {
          parentCommentId = decision.replyToCommentId;
        } else {
          // LLM returned an ID but it wasn't in our comment threads - log this
          logger.warn(
            `LLM returned replyToCommentId "${decision.replyToCommentId}" but it wasn't found in comment threads. Creating top-level comment instead.`,
            {
              agentUserId,
              postId: selectedPost.id,
              availableIds: allCommentIds,
            },
            'AutonomousCommenting'
          );
        }
      }

      // Execute via DirectExecutors (handles DB insert)
      const result = await executeDirectComment({
        agentUserId,
        postId: selectedPost.id,
        content: cleanContent,
        parentCommentId: parentCommentId ?? undefined,
      });

      if (!result.success) {
        logger.warn(
          `Failed to create comment: ${result.error}`,
          { agentUserId },
          'AutonomousCommenting'
        );
        return null;
      }

      // Log the comment with prompt and completion for debugging/review
      await agentService.createLog(agentUserId, {
        type: 'comment',
        level: 'info',
        message: `Created comment on post ${selectedPost.id}${parentCommentId ? ` (reply to ${parentCommentId})` : ''}: ${cleanContent.substring(0, 100)}${cleanContent.length > 100 ? '...' : ''}`,
        prompt: usedPrompt ?? undefined,
        completion: llmCompletion ?? undefined,
        metadata: {
          commentId: result.commentId ?? null,
          postId: selectedPost.id,
          parentCommentId: parentCommentId ?? null,
          contentLength: cleanContent.length,
          agentDisplayName,
        },
      });

      logger.info(
        `Agent ${agentDisplayName} commented on post ${selectedPost.id}${parentCommentId ? ` (reply to ${parentCommentId})` : ''}`,
        { content: cleanContent.substring(0, 50) },
        'AutonomousCommenting'
      );

      return result.commentId ?? null;
    }

    return null;
  }
}

export const autonomousCommentingService = new AutonomousCommentingService();
