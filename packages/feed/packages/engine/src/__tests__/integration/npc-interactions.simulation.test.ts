import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LLMJsonClient } from '../../llm/types';
import {
  npcSocialEngagementService,
  processNPCSocialEngagements,
} from '../../services/npc-social-engagement-service';
import {
  type DiscourseActor,
  generateNPCRepliesFromPreviousTicks,
} from '../../services/post-generation-helpers';
import { StaticDataRegistry } from '../../services/static-data-registry';
import {
  db,
  initializeDatabaseMode,
  initializeSimulationMode,
} from '../../storage-bridge';

const mockLLM: LLMJsonClient = {
  async generateJSON<T>(_prompt, _schema, options) {
    const promptType = options?.promptType ?? 'unknown';

    if (promptType === 'npc-comment') {
      return { comment: 'Valid NPC comment.' } as T;
    }

    if (promptType === 'npc-comment-reply') {
      return { comment: 'Valid NPC comment reply.' } as T;
    }

    if (promptType === 'npc_quote_post') {
      return { response: { quote_comment: 'Quote-post commentary.' } } as T;
    }

    if (promptType === 'npc_reply_to_post') {
      return { response: { reply: 'Reply content.' } } as T;
    }

    return {} as T;
  },
};

describe('NPC interactions (simulation mode)', () => {
  beforeEach(async () => {
    const basePath = mkdtempSync(join(tmpdir(), 'feed-engine-npc-'));
    await initializeSimulationMode(basePath);
  });

  afterEach(() => {
    initializeDatabaseMode();
  });

  test('processNPCSocialEngagements creates likes/shares/comments', async () => {
    const actors = StaticDataRegistry.getAllActors();
    expect(actors.length).toBeGreaterThanOrEqual(2);

    const a1 = actors[0]!;
    const a2 = actors[1]!;
    const now = new Date('2026-01-01T00:10:00.000Z');
    const postTime = new Date(now.getTime() - 5 * 60 * 1000);

    await db.post.create({
      data: {
        id: 'seed-post-1',
        type: 'post',
        content: 'Seed post one.',
        authorId: a1.id,
        gameId: 'continuous',
        dayNumber: 1,
        timestamp: postTime,
      },
    });

    await db.post.create({
      data: {
        id: 'seed-post-2',
        type: 'post',
        content: 'Seed post two.',
        authorId: a2.id,
        gameId: 'continuous',
        dayNumber: 1,
        timestamp: postTime,
      },
    });

    npcSocialEngagementService.setLLMClient(mockLLM);

    const res = await processNPCSocialEngagements({
      now,
      random: () => 0,
      skipActorProbability: 0,
    });

    expect(res.likesCreated).toBeGreaterThan(0);
    expect(res.sharesCreated).toBeGreaterThan(0);
    expect(res.commentsCreated).toBeGreaterThan(0);

    // Verify persisted artifacts in storage
    expect(await db.reaction.count()).toBeGreaterThan(0);
    expect(await db.share.count()).toBeGreaterThan(0);
    expect(await db.comment.count()).toBeGreaterThan(0);
    expect(await db.npcInteraction.count()).toBeGreaterThan(0);

    // Verify nested comment threads (replies to comments) can be created
    const comments = await db.comment.findMany({
      select: { id: true, parentCommentId: true },
    });
    expect(comments.some((c) => c.parentCommentId !== null)).toBe(true);
  });

  test('quoted author can comment on quote-posts (clapback)', async () => {
    const actors = StaticDataRegistry.getAllActors();
    expect(actors.length).toBeGreaterThanOrEqual(2);

    const originalAuthor = actors[0]!;
    const quoter = actors[1]!;
    const now = new Date('2026-01-01T00:40:00.000Z');
    const postTime = new Date(now.getTime() - 5 * 60 * 1000);

    const originalPostId = 'seed-orig-post';
    const quotePostId = 'seed-quote-post';

    await db.post.create({
      data: {
        id: originalPostId,
        type: 'post',
        content: 'Original post to be quote-posted.',
        authorId: originalAuthor.id,
        gameId: 'continuous',
        dayNumber: 1,
        timestamp: postTime,
      },
    });

    await db.post.create({
      data: {
        id: quotePostId,
        type: 'quote',
        content: 'Quote commentary on the original post.',
        authorId: quoter.id,
        originalPostId,
        gameId: 'continuous',
        dayNumber: 1,
        timestamp: postTime,
      },
    });

    npcSocialEngagementService.setLLMClient(mockLLM);

    await processNPCSocialEngagements({
      now,
      random: () => 0,
      skipActorProbability: 0,
    });

    const clapbacks = await db.comment.findMany({
      where: { postId: quotePostId, authorId: originalAuthor.id },
    });
    expect(clapbacks.length).toBeGreaterThan(0);
  });

  test('generateNPCRepliesFromPreviousTicks can create quote-posts', async () => {
    const actors = StaticDataRegistry.getAllActors();
    expect(actors.length).toBeGreaterThanOrEqual(4);

    const originalAuthor = actors[2]!;
    const engager = actors[3]!;

    const now = new Date('2026-01-01T00:20:00.000Z');
    const originalPostId = 'orig-quote-target';
    const originalPostTime = new Date(now.getTime() - 5 * 60 * 1000);

    await db.post.create({
      data: {
        id: originalPostId,
        type: 'post',
        content: 'Original post to be quote-posted.',
        authorId: originalAuthor.id,
        gameId: 'continuous',
        dayNumber: 1,
        timestamp: originalPostTime,
      },
    });

    const discourseActors: DiscourseActor[] = [
      {
        id: originalAuthor.id,
        name: originalAuthor.name,
        description: originalAuthor.description ?? null,
        personality: originalAuthor.personality ?? null,
        postStyle: originalAuthor.postStyle ?? null,
        postExample: Array.isArray(originalAuthor.postExample)
          ? originalAuthor.postExample
          : undefined,
        affiliations: originalAuthor.affiliations ?? [],
        domain: originalAuthor.domain ?? [],
        role: originalAuthor.role ?? null,
      },
      {
        id: engager.id,
        name: engager.name,
        description: engager.description ?? null,
        personality: engager.personality ?? null,
        postStyle: engager.postStyle ?? null,
        postExample: Array.isArray(engager.postExample)
          ? engager.postExample
          : undefined,
        affiliations: engager.affiliations ?? [],
        domain: engager.domain ?? [],
        role: engager.role ?? null,
      },
    ];

    const created = await generateNPCRepliesFromPreviousTicks(
      mockLLM,
      discourseActors,
      '',
      now,
      1,
      1,
      { random: () => 0, quoteProbability: 1 }
    );

    expect(created).toBe(1);

    const quotes = await db.post.findMany({
      where: { type: 'quote', originalPostId },
    });

    expect(quotes.length).toBe(1);
    expect(quotes[0]?.authorId).not.toBe(originalAuthor.id);

    expect(
      await db.npcInteraction.count({ where: { interactionType: 'quote' } })
    ).toBeGreaterThan(0);
  });

  test('generateNPCRepliesFromPreviousTicks can create replies', async () => {
    const actors = StaticDataRegistry.getAllActors();
    expect(actors.length).toBeGreaterThanOrEqual(6);

    const originalAuthor = actors[4]!;
    const engager = actors[5]!;

    const now = new Date('2026-01-01T00:30:00.000Z');
    const originalPostId = 'orig-reply-target';
    const originalPostTime = new Date(now.getTime() - 5 * 60 * 1000);

    await db.post.create({
      data: {
        id: originalPostId,
        type: 'post',
        content: 'Original post to be replied to.',
        authorId: originalAuthor.id,
        gameId: 'continuous',
        dayNumber: 1,
        timestamp: originalPostTime,
      },
    });

    const discourseActors: DiscourseActor[] = [
      {
        id: originalAuthor.id,
        name: originalAuthor.name,
        description: originalAuthor.description ?? null,
        personality: originalAuthor.personality ?? null,
        postStyle: originalAuthor.postStyle ?? null,
        postExample: Array.isArray(originalAuthor.postExample)
          ? originalAuthor.postExample
          : undefined,
        affiliations: originalAuthor.affiliations ?? [],
        domain: originalAuthor.domain ?? [],
        role: originalAuthor.role ?? null,
      },
      {
        id: engager.id,
        name: engager.name,
        description: engager.description ?? null,
        personality: engager.personality ?? null,
        postStyle: engager.postStyle ?? null,
        postExample: Array.isArray(engager.postExample)
          ? engager.postExample
          : undefined,
        affiliations: engager.affiliations ?? [],
        domain: engager.domain ?? [],
        role: engager.role ?? null,
      },
    ];

    const created = await generateNPCRepliesFromPreviousTicks(
      mockLLM,
      discourseActors,
      '',
      now,
      1,
      1,
      { random: () => 0, quoteProbability: 0 }
    );

    expect(created).toBe(1);

    const replies = await db.post.findMany({
      where: { type: 'reply', commentOnPostId: originalPostId },
    });

    expect(replies.length).toBe(1);
    expect(replies[0]?.authorId).not.toBe(originalAuthor.id);
    expect(replies[0]?.originalPostId).toBe(originalPostId);

    expect(
      await db.npcInteraction.count({ where: { interactionType: 'reply' } })
    ).toBeGreaterThan(0);
  });
});
