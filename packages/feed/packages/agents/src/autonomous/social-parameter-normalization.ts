import {
  Actions,
  type AgentTickContext,
} from "./templates/multi-step-decision";

type DecisionParameters = Record<string, unknown>;

const PLACEHOLDER_TOKENS = new Set([
  "",
  "0",
  "none",
  "null",
  "nil",
  "n/a",
  "na",
  "unknown",
  "undefined",
  "post",
  "comment",
  "chat",
  "user",
]);

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeIdInput(value: unknown): string | undefined {
  const trimmed =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(Math.trunc(value))
        : typeof value === "bigint"
          ? value.toString()
          : "";
  if (!trimmed) {
    return undefined;
  }

  const normalized = normalizeToken(trimmed);
  if (PLACEHOLDER_TOKENS.has(normalized)) {
    return undefined;
  }

  return trimmed;
}

function extractOrdinal(value: string): number | undefined {
  const direct = value.match(/^#?(\d+)$/)?.[1];
  if (direct) {
    return Number.parseInt(direct, 10);
  }

  const indexed = value.match(/(?:post|comment|chat|user)\s*#?\s*(\d+)/i)?.[1];
  if (indexed) {
    return Number.parseInt(indexed, 10);
  }

  return undefined;
}

function extractEmbeddedId(value: string): string | undefined {
  const explicitId =
    value.match(/\bid\s*:\s*([A-Za-z0-9_-]+)/i)?.[1] ??
    value.match(
      /\b(?:postId|commentId|chatId|userId|recipientId)\s*:\s*([A-Za-z0-9_-]+)/i,
    )?.[1];
  return explicitId?.trim();
}

function resolveCandidateId<T extends { id: string }>(
  rawValue: unknown,
  candidates: T[],
): string | undefined {
  const normalizedInput = normalizeIdInput(rawValue);
  if (!normalizedInput) {
    return undefined;
  }

  const exact = candidates.find(
    (candidate) => candidate.id === normalizedInput,
  );
  if (exact) {
    return exact.id;
  }

  const embeddedId = extractEmbeddedId(normalizedInput);
  if (embeddedId) {
    const embedded = candidates.find(
      (candidate) => candidate.id === embeddedId,
    );
    if (embedded) {
      return embedded.id;
    }
  }

  const ordinal = extractOrdinal(normalizedInput);
  if (ordinal !== undefined && ordinal >= 1 && ordinal <= candidates.length) {
    return candidates[ordinal - 1]?.id;
  }

  const numericPrefix = normalizedInput.match(/^(\d+)/)?.[1];
  if (numericPrefix) {
    const prefixed = candidates.find(
      (candidate) => candidate.id === numericPrefix,
    );
    if (prefixed) {
      return prefixed.id;
    }
  }

  return undefined;
}

function dedupeRecentPostAuthors(
  context: AgentTickContext,
  agentUserId: string,
): Array<{ id: string }> {
  const seen = new Set<string>();
  const authors: Array<{ id: string }> = [];

  for (const post of context.recentPosts) {
    if (post.authorId === agentUserId || seen.has(post.authorId)) {
      continue;
    }
    seen.add(post.authorId);
    authors.push({ id: post.authorId });
  }

  return authors;
}

function chooseCommentPost(
  context: AgentTickContext,
  agentUserId: string,
): string | undefined {
  return (
    context.recentPosts.find(
      (post) => post.authorId !== agentUserId && !post.agentComment,
    )?.id ??
    context.recentPosts.find((post) => post.authorId !== agentUserId)?.id ??
    context.recentPosts[0]?.id
  );
}

function chooseLikePost(
  context: AgentTickContext,
  agentUserId: string,
): string | undefined {
  return (
    context.recentPosts.find(
      (post) => post.authorId !== agentUserId && !post.agentLiked,
    )?.id ??
    context.recentPosts.find((post) => post.authorId !== agentUserId)?.id ??
    context.recentPosts[0]?.id
  );
}

function chooseRepostPost(
  context: AgentTickContext,
  agentUserId: string,
): string | undefined {
  return (
    context.recentPosts.find(
      (post) => post.authorId !== agentUserId && !post.agentReposted,
    )?.id ??
    context.recentPosts.find((post) => post.authorId !== agentUserId)?.id ??
    context.recentPosts[0]?.id
  );
}

function choosePendingCommentTarget(
  context: AgentTickContext,
): { id: string; postId: string } | undefined {
  const target = context.pendingCommentReplies[0];
  if (!target) {
    return undefined;
  }

  return { id: target.id, postId: target.postId };
}

function choosePendingChatId(
  context: AgentTickContext,
  groupOnly = false,
): string | undefined {
  if (groupOnly) {
    return context.groupChats?.[0]?.id;
  }

  return context.pendingChatMessages[0]?.chatId;
}

export function normalizeSocialDecisionParameters(
  action: string,
  parameters: DecisionParameters,
  context: AgentTickContext,
  agentUserId: string,
): DecisionParameters {
  const nextParameters: DecisionParameters = { ...parameters };
  const recentPosts = context.recentPosts.map((post) => ({ id: post.id }));
  const pendingReplies = context.pendingCommentReplies.map((reply) => ({
    id: reply.id,
    postId: reply.postId,
  }));
  const pendingChats = context.pendingChatMessages.map((message) => ({
    id: message.chatId,
  }));
  const groupChats =
    context.groupChats?.map((group) => ({
      id: group.id,
    })) ?? [];
  const recentAuthors = dedupeRecentPostAuthors(context, agentUserId);

  switch (action) {
    case Actions.COMMENT: {
      const resolvedParentCommentId = resolveCandidateId(
        nextParameters.parentCommentId,
        pendingReplies,
      );
      const parentTarget = resolvedParentCommentId
        ? pendingReplies.find((reply) => reply.id === resolvedParentCommentId)
        : undefined;
      const resolvedPostId =
        resolveCandidateId(nextParameters.postId, recentPosts) ??
        parentTarget?.postId ??
        chooseCommentPost(context, agentUserId);

      if (resolvedPostId) {
        nextParameters.postId = resolvedPostId;
      } else {
        delete nextParameters.postId;
      }

      if (resolvedParentCommentId) {
        nextParameters.parentCommentId = resolvedParentCommentId;
      } else if ("parentCommentId" in nextParameters) {
        delete nextParameters.parentCommentId;
      }

      return nextParameters;
    }

    case Actions.REPLY_COMMENT: {
      const resolvedCommentId = resolveCandidateId(
        nextParameters.commentId,
        pendingReplies,
      );
      const target =
        (resolvedCommentId &&
          pendingReplies.find((reply) => reply.id === resolvedCommentId)) ??
        choosePendingCommentTarget(context);

      if (target) {
        nextParameters.commentId = target.id;
        nextParameters.postId = target.postId;
      } else {
        delete nextParameters.commentId;
        delete nextParameters.postId;
      }

      return nextParameters;
    }

    case Actions.LIKE: {
      const resolvedPostId =
        resolveCandidateId(nextParameters.postId, recentPosts) ??
        chooseLikePost(context, agentUserId);

      if (resolvedPostId) {
        nextParameters.postId = resolvedPostId;
      } else {
        delete nextParameters.postId;
      }

      return nextParameters;
    }

    case Actions.REPOST: {
      const resolvedPostId =
        resolveCandidateId(nextParameters.postId, recentPosts) ??
        chooseRepostPost(context, agentUserId);

      if (resolvedPostId) {
        nextParameters.postId = resolvedPostId;
      } else {
        delete nextParameters.postId;
      }

      return nextParameters;
    }

    case Actions.FOLLOW:
    case Actions.UNFOLLOW: {
      const resolvedUserId =
        resolveCandidateId(nextParameters.userId, recentAuthors) ??
        recentAuthors[0]?.id;

      if (resolvedUserId) {
        nextParameters.userId = resolvedUserId;
      } else {
        delete nextParameters.userId;
      }

      return nextParameters;
    }

    case Actions.DM: {
      const resolvedRecipientId =
        resolveCandidateId(nextParameters.recipientId, recentAuthors) ??
        recentAuthors[0]?.id;

      if (resolvedRecipientId) {
        nextParameters.recipientId = resolvedRecipientId;
      } else {
        delete nextParameters.recipientId;
      }

      return nextParameters;
    }

    case Actions.REPLY_CHAT: {
      const resolvedChatId =
        resolveCandidateId(nextParameters.chatId, pendingChats) ??
        choosePendingChatId(context);

      if (resolvedChatId) {
        nextParameters.chatId = resolvedChatId;
      } else {
        delete nextParameters.chatId;
      }

      return nextParameters;
    }

    case Actions.GROUP_MESSAGE: {
      const resolvedChatId =
        resolveCandidateId(nextParameters.chatId, groupChats) ??
        choosePendingChatId(context, true);

      if (resolvedChatId) {
        nextParameters.chatId = resolvedChatId;
      } else {
        delete nextParameters.chatId;
      }

      return nextParameters;
    }

    default:
      return nextParameters;
  }
}
