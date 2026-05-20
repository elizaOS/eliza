/**
 * Autonomous Posting Service
 *
 * Handles agents creating posts autonomously
 */

import { countTokensSync, truncateToTokenLimitSync } from '@babylon/api';
import { agentTrades, db, desc, eq, posts } from '@babylon/db';
import {
  characterMappingService,
  formatRandomContext,
  generateRandomMarketContext,
  generateWorldContext,
} from '@babylon/engine';
import { getTimeAgo } from '@babylon/shared';
import type { IAgentRuntime } from '@elizaos/core';
import { parseKeyValueXml } from '@elizaos/core';
import { callGroqDirect } from '../llm/direct-groq';
import { agentService } from '../services/AgentService';
import { getAgentConfig } from '../shared/agent-config';
import { logger } from '../shared/logger';
import { getAgentContext } from './agent-context';
import { executeDirectPost } from './DirectExecutors';

export class AutonomousPostingService {
  /**
   * Generate and create a post for an agent
   *
   * Supports both USER_CONTROLLED agents (User table) and NPCs (ActorState table)
   */
  async createAgentPost(
    agentUserId: string,
    _runtime: IAgentRuntime
  ): Promise<string | null> {
    // Resolve agent context (NPC vs USER_CONTROLLED)
    const { displayName: agentDisplayName, lifetimePnL: agentLifetimePnL } =
      await getAgentContext(agentUserId);

    const config = await getAgentConfig(agentUserId);

    // Get recent agent activity for context
    const recentTrades = await db
      .select()
      .from(agentTrades)
      .where(eq(agentTrades.agentUserId, agentUserId))
      .orderBy(desc(agentTrades.executedAt))
      .limit(5);

    const recentPosts = await db
      .select({
        id: posts.id,
        content: posts.content,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(eq(posts.authorId, agentUserId))
      .orderBy(desc(posts.createdAt))
      .limit(5);

    // Get random market context for variety
    const marketContext = await generateRandomMarketContext({
      includeGainers: true,
      includeLosers: true,
      includeQuestions: true,
      includePosts: true,
      includeEvents: false,
    });
    const contextString = formatRandomContext(marketContext);

    // Get world context for consistent parody names
    const worldContext = await generateWorldContext({ maxActors: 20 });

    // Build prompt for post generation — CHARACTER-CENTRIC, not market-centric
    const MAX_TOKENS = 280;

    // Get NPC actor data for rich character context
    let npcVoice = '';
    let npcPersonality = '';
    let npcDomains = '';
    let npcPostExamples = '';
    try {
      const { StaticDataRegistry } = await import('@babylon/engine');
      const actor = StaticDataRegistry.getActor(agentUserId);
      if (actor) {
        npcVoice = actor.voice || '';
        npcPersonality = actor.personality || '';
        npcDomains = actor.domain?.join(', ') || '';
        if (actor.postExample && actor.postExample.length > 0) {
          const shuffled = [...actor.postExample].sort(
            () => Math.random() - 0.5
          );
          npcPostExamples = shuffled
            .slice(0, 3)
            .map((e) => `  "${e}"`)
            .join('\n');
        }
      }
    } catch {
      /* not an NPC or registry unavailable */
    }

    const prompt = `You are ${agentDisplayName}.

${npcPersonality ? `PERSONALITY: ${npcPersonality}` : ''}
${npcDomains ? `YOUR INTERESTS: ${npcDomains}` : ''}
${npcVoice ? `YOUR VOICE: ${npcVoice}` : ''}
${npcPostExamples ? `HOW YOU TALK (match this style):\n${npcPostExamples}` : ''}

YOUR RECENT POSTS (DO NOT repeat any theme, phrase, topic, or structure):
${recentPosts.length > 0 ? recentPosts.map((p, i) => `[${i + 1}] "${p.content}" (${getTimeAgo(p.createdAt)})`).join('\n') : 'No recent posts yet — this is your first impression. Make it count.'}

YOUR STATE:
${recentTrades.length > 0 ? `Recent trades: ${recentTrades.map((t) => `${t.action} ${t.ticker}`).join(', ')}` : 'No recent trades'}
P&L: ${agentLifetimePnL}

WHAT'S HAPPENING IN THE WORLD:
${worldContext.worldFacts || 'Things are quiet.'}
${worldContext.currentMarkets ? `\nMarkets: ${worldContext.currentMarkets}` : ''}
${worldContext.realityGrounding || ''}

KNOWN PEOPLE AND COMPANIES:
${worldContext.worldActors}

Write a short post (1-2 sentences) as ${agentDisplayName}.

RULES:
- BE YOURSELF. Post about whatever interests YOU — your domains, your opinions, your takes, your mood.
- You CAN mention markets, trades, prices if it's natural for your character — but don't force it.
- Post about tech, politics, philosophy, drama, hot takes, personal observations, reactions to news — whatever fits your personality.
- Reference specific people and companies from the KNOWN PEOPLE list above (use parody names, never real names).
- NO hashtags or emojis.
- NEVER repeat themes, phrases, or openings from your recent posts above.
- Be direct and confident. No hedging ("maybe", "considering", "watching closely").
- Your post should be immediately recognizable as YOU by voice alone.
${contextString}

<response>
<action>post</action>
<text>your post here</text>
</response>

Or skip if you have nothing fresh to say:
<response>
<action>skip</action>
<reason>why</reason>
</response>`;

    // Ensure prompt fits within 32K context limit (W&B trained models)
    const estimatedTokens = countTokensSync(prompt);
    let finalPrompt = prompt;

    if (estimatedTokens > 30000) {
      // 30K with 2K safety margin
      logger.warn(
        `Post generation prompt too long: ${estimatedTokens} tokens, truncating`,
        { agentUserId }
      );
      const truncated = truncateToTokenLimitSync(prompt, 30000, {
        ellipsis: true,
      });
      finalPrompt = truncated.text;
      logger.info(`Truncated to ${truncated.tokens} tokens`, { agentUserId });
    }

    // Use large model (qwen3-32b or trained W&B model) for post generation with retry loop
    const MAX_ATTEMPTS = 3;
    let cleanContent: string | null = null;
    let llmCompletion: string | null = null;
    let usedPrompt: string | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const isRetry = attempt > 1;
      const currentPrompt = isRetry
        ? `${finalPrompt}\n\nREMINDER: You MUST output valid XML. Start with <response>, include <action> (post or skip), and <text> for posts. No <think> tags.`
        : finalPrompt;

      const postContent = await callGroqDirect({
        prompt: currentPrompt,
        system: config?.systemPrompt ?? undefined,
        modelSize: 'large', // Uses trained W&B model if available, else qwen3-32b
        runtime: _runtime, // Pass runtime to access W&B trained models AND trajectory context
        temperature: isRetry ? 0.6 : 0.8,
        maxTokens: MAX_TOKENS,
        actionType: 'generate_autonomous_post',
        purpose: 'action', // RLAIF: This is a content generation action
      });

      // Extract <response>...</response> block before parsing
      const responseMatch = postContent.match(
        /<response>([\s\S]*?)<\/response>/i
      );
      if (!responseMatch) {
        logger.warn(
          'No <response> block found in post generation',
          {
            agentUserId,
            attempt,
            raw: postContent.substring(0, 300),
          },
          'AutonomousPosting'
        );
        continue;
      }

      // Parse the extracted XML response
      const parsed = parseKeyValueXml(responseMatch[0]) as {
        action?: string;
        text?: string;
        reason?: string;
      } | null;

      // Check if agent chose to skip
      if (parsed?.action === 'skip') {
        logger.info(
          `Agent ${agentDisplayName} chose to skip posting`,
          {
            agentUserId,
            reason: parsed.reason || 'No reason given',
          },
          'AutonomousPosting'
        );
        return null;
      }

      // Check if we got valid text
      if (!parsed?.text || parsed.text.trim().length === 0) {
        logger.warn(
          'Failed to parse XML response in post generation',
          {
            agentUserId,
            attempt,
            raw: postContent.substring(0, 300),
          },
          'AutonomousPosting'
        );
        continue;
      }

      // Success! Clean up the response and capture LLM output
      cleanContent = parsed.text.trim().replace(/^["']|["']$/g, '');
      llmCompletion = postContent;
      usedPrompt = currentPrompt;
      break;
    }

    // If all attempts failed, return null
    if (!cleanContent) {
      logger.error(
        `Failed to generate valid post after ${MAX_ATTEMPTS} attempts`,
        { agentUserId },
        'AutonomousPosting'
      );
      return null;
    }

    // Post-process to fix any real names that slipped through
    const processed = await characterMappingService.transformText(cleanContent);
    cleanContent = processed.transformedText;

    if (processed.replacementCount > 0) {
      logger.warn(
        `Fixed ${processed.replacementCount} real name(s) in agent post`,
        {
          original: cleanContent.substring(0, 100),
          fixed: processed.transformedText.substring(0, 100),
        },
        'AutonomousPosting'
      );
    }

    logger.info(
      'LLM generated post',
      {
        agentUserId,
        content: cleanContent,
        length: cleanContent.length,
      },
      'AutonomousPosting'
    );

    if (!cleanContent || cleanContent.length < 10) {
      logger.warn(
        `Generated post too short or empty for agent ${agentUserId}`,
        {
          content: cleanContent,
          length: cleanContent.length,
        },
        'AutonomousPosting'
      );
      return null;
    }

    // Execute via DirectExecutors (handles DB insert and tagging)
    const result = await executeDirectPost({
      agentUserId,
      content: cleanContent,
    });

    if (!result.success) {
      logger.warn(
        `Failed to create post: ${result.error}`,
        { agentUserId },
        'AutonomousPosting'
      );
      return null;
    }

    // Log the post with prompt and completion for debugging/review
    await agentService.createLog(agentUserId, {
      type: 'post',
      level: 'info',
      message: `Created post: ${cleanContent.substring(0, 100)}${cleanContent.length > 100 ? '...' : ''}`,
      prompt: usedPrompt ?? undefined,
      completion: llmCompletion ?? undefined,
      metadata: {
        postId: result.postId ?? null,
        contentLength: cleanContent.length,
        agentDisplayName,
      },
    });

    logger.info(
      `Agent ${agentDisplayName} created post: ${result.postId}`,
      undefined,
      'AutonomousPosting'
    );

    return result.postId ?? null;
  }
}

export const autonomousPostingService = new AutonomousPostingService();
