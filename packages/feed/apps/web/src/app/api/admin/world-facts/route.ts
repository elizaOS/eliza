/**
 * Admin World Facts API
 *
 * @route GET /api/admin/world-facts - Get world facts
 * @route POST /api/admin/world-facts - Create/update world facts
 * @route DELETE /api/admin/world-facts - Delete world fact
 * @access Admin
 *
 * @description
 * Manages world facts, RSS feeds, parody headlines, and character mappings.
 * GET returns all facts and related data. POST creates/updates facts.
 * DELETE removes a fact.
 *
 * @openapi
 * /api/admin/world-facts:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get world facts
 *     description: Returns all world facts, RSS feeds, parodies, and mappings (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Facts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 facts:
 *                   type: array
 *                 rssFeeds:
 *                   type: array
 *                 parodies:
 *                   type: array
 *                 characterMappings:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *   post:
 *     tags:
 *       - Admin
 *     summary: Create/update world facts
 *     description: Creates or updates world facts (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Facts updated successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *   delete:
 *     tags:
 *       - Admin
 *     summary: Delete world fact
 *     description: Deletes a world fact (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               factId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Fact deleted successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const { facts } = await fetch('/api/admin/world-facts', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import { requireAdmin, successResponse, withErrorHandling } from '@feed/api';
// Removed fs and path imports - using TypeScript imports instead
import { db } from '@feed/db';
import {
  characterMappingService,
  createParodyHeadlineGenerator,
  dailyTopicService,
  rssFeedService,
  worldFactsGenerator,
  worldFactsService,
} from '@feed/engine';
import { generateSnowflakeId, logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * GET /api/admin/world-facts - Get all world facts and related data
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const facts = await worldFactsService.getAllFacts();
  const rssFeeds = await rssFeedService.getUntransformedHeadlines(10);
  const parodyGenerator = createParodyHeadlineGenerator();
  const recentParodies = await parodyGenerator.getRecentParodies(10);
  const characterMappings =
    await characterMappingService.getCharacterMappings();
  const organizationMappings =
    await characterMappingService.getOrganizationMappings();

  const context = await worldFactsService.generateWorldContext(true);
  const dailyTopic = await dailyTopicService.getCurrentTopic();
  const dailyTopicCandidates = await dailyTopicService.listCandidates();

  // Load reality grounding content from TypeScript export
  const { realityGroundingContent: content } = await import('@feed/engine');
  const realityGroundingContent = content;

  return successResponse({
    facts,
    rssFeeds,
    recentParodies,
    characterMappings,
    organizationMappings,
    context,
    dailyTopic,
    dailyTopicCandidates,
    realityGroundingContent,
  });
});

/**
 * POST /api/admin/world-facts - Create or update world facts
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const body = await request.json();
  const { action, data } = body;

  switch (action) {
    case 'update_fact': {
      // Simple: just update by value (id is used to find the fact)
      const { id, value } = data;
      if (!id || !value) {
        return successResponse({ error: 'Missing id or value' }, 400);
      }

      const fact = await worldFactsService.updateFactById(id, value);
      logger.info(`Updated world fact: ${id}`, { fact }, 'WorldFactsAdmin');
      return successResponse({ fact });
    }

    case 'add_fact': {
      // Add a new fact by value (simple string)
      const { value, category } = data;
      if (!value) {
        return successResponse({ error: 'Missing value' }, 400);
      }

      // Use specified category or default to 'general'
      const factCategory = category || 'general';
      const key = value
        .split(':')[0]
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .substring(0, 50);
      const label = value.split(':')[0].trim().substring(0, 60);

      // Check if fact already exists
      const existing = await db.worldFact.findFirst({
        where: {
          AND: [
            { category: { equals: factCategory } },
            { key: { equals: key } },
          ],
        },
      });

      let fact;
      if (existing) {
        fact = await db.worldFact.update({
          where: { id: existing.id },
          data: {
            label,
            value,
            lastUpdated: new Date(),
          },
        });
      } else {
        fact = await db.worldFact.create({
          data: {
            id: await generateSnowflakeId(),
            category: factCategory,
            key,
            label,
            value,
            source: 'default',
            priority: 0,
            lastUpdated: new Date(),
            updatedAt: new Date(),
          },
        });
      }

      logger.info(`Added world fact: ${fact.id}`, { fact }, 'WorldFactsAdmin');
      return successResponse({ fact });
    }

    case 'bulk_update_facts': {
      // Simple: array of strings
      const { facts } = data;
      if (!Array.isArray(facts)) {
        return successResponse(
          { error: 'facts must be an array of strings' },
          400
        );
      }
      await worldFactsService.bulkUpdateFacts(facts);
      return successResponse({ success: true });
    }

    case 'toggle_fact': {
      const fact = await worldFactsService.toggleFactActive(data.id);
      return successResponse({ fact });
    }

    case 'delete_fact': {
      await worldFactsService.deleteFact(data.id);
      logger.info(
        `Deleted world fact: ${data.id}`,
        undefined,
        'WorldFactsAdmin'
      );
      return successResponse({ success: true });
    }

    case 'fetch_rss': {
      // Trigger RSS feed fetch manually
      const result = await rssFeedService.fetchAllFeeds();
      logger.info('Manual RSS fetch triggered', result, 'WorldFactsAdmin');
      return successResponse({ result });
    }

    case 'set_daily_topic_override': {
      const topicLabel = String(data?.topicLabel || '').trim();
      const summary = String(data?.summary || '').trim();
      if (!topicLabel) {
        return successResponse({ error: 'Missing topicLabel' }, 400);
      }

      const topic = await dailyTopicService.setManualTopic({
        date: data?.date ? new Date(data.date) : new Date(),
        topicLabel,
        summary,
      });
      return successResponse({ topic });
    }

    case 'clear_daily_topic_override': {
      const topic = await dailyTopicService.clearOverride(
        data?.date ? new Date(data.date) : new Date()
      );
      return successResponse({ topic });
    }

    case 'recompute_daily_topic': {
      const topic = await dailyTopicService.recomputeTopicForDate(
        data?.date ? new Date(data.date) : new Date()
      );
      return successResponse({ topic });
    }

    case 'generate_parodies': {
      // Generate parodies from untransformed headlines
      const headlines = await rssFeedService.getUntransformedHeadlines(10);
      const generator = createParodyHeadlineGenerator();
      const parodies = await generator.processHeadlines(headlines);
      logger.info(
        `Generated ${parodies.length} parody headlines`,
        undefined,
        'WorldFactsAdmin'
      );
      return successResponse({ parodies });
    }

    case 'refresh_mappings': {
      // Refresh character/org mapping cache
      characterMappingService.refreshCache();
      return successResponse({ success: true });
    }

    case 'generate_world_facts': {
      // Generate new world facts from game activity
      logger.info(
        'Manual world facts generation triggered',
        undefined,
        'WorldFactsAdmin'
      );
      const result = await worldFactsGenerator.generateNewWorldFacts();
      logger.info(
        `Generated ${result.generated} world facts, archived ${result.archived}`,
        result,
        'WorldFactsAdmin'
      );
      return successResponse({ result });
    }

    default:
      return successResponse({ error: 'Unknown action' }, 400);
  }
});

/**
 * DELETE /api/admin/world-facts - Delete a world fact
 */
export const DELETE = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return successResponse({ error: 'Missing id parameter' }, 400);
  }

  await worldFactsService.deleteFact(id);
  logger.info(`Deleted world fact: ${id}`, undefined, 'WorldFactsAdmin');

  return successResponse({ success: true });
});
