/**
 * Autonomous Batch Response Service
 *
 * Handles batch evaluation and response to pending interactions:
 * - Comment replies (unified: comments on agent's posts + replies to agent's comments)
 * - New messages in chats
 *
 * Instead of responding to everything, this service:
 * 1. Gathers all pending interactions
 * 2. Presents them to the agent with context
 * 3. Agent decides which ones warrant a response (boolean array)
 * 4. Executes responses for approved interactions
 */

import { countTokensSync, truncateToTokenLimitSync } from '@babylon/api';
import type { UserAgentConfig } from '@babylon/db';
import type { IAgentRuntime } from '@elizaos/core';
import { parseKeyValueXml } from '@elizaos/core';
import { callGroqDirect } from '../llm/direct-groq';
import { agentService } from '../services/AgentService';
import { getAgentConfig } from '../shared/agent-config';
import { logger } from '../shared/logger';
import { type AgentContext, getAgentContext } from './agent-context';
import { executeDirectComment, executeDirectMessage } from './DirectExecutors';
import type {
  PendingChatMessage,
  PendingCommentReply,
} from './templates/multi-step-decision';
import {
  gatherPendingChatMessages,
  gatherPendingCommentReplies,
} from './utils';

// =============================================================================
// Types
// =============================================================================

interface ThreadMessage {
  authorName: string;
  content: string;
  isYou: boolean;
  depth: number;
}

interface PostInfo {
  id: string;
  content: string;
  authorName: string;
  isYourPost: boolean;
}

interface PendingInteraction {
  type: 'comment_reply' | 'chat_message';
  id: string;
  // Comment reply fields
  postId?: string;
  targetCommentId?: string;
  post?: PostInfo;
  thread?: ThreadMessage[];
  // Chat message fields
  chatId?: string;
  // Common fields
  author: string;
  content: string;
  context: string; // Formatted context string for prompt
  timestamp: Date;
}

interface ResponseDecision {
  shouldRespond: boolean;
  priority?: 'low' | 'medium' | 'high';
  reasoning?: string;
}

// =============================================================================
// Service
// =============================================================================

export class AutonomousBatchResponseService {
  // ===========================================================================
  // Helper: Format interactions grouped by post for evaluation prompt
  // ===========================================================================
  private formatInteractionsGroupedByPost(
    interactions: PendingInteraction[]
  ): string {
    // Group interactions by postId
    const byPost = new Map<string, PendingInteraction[]>();
    const chatMessages: PendingInteraction[] = [];

    for (const interaction of interactions) {
      if (interaction.type === 'chat_message' || !interaction.postId) {
        chatMessages.push(interaction);
      } else {
        const postInteractions = byPost.get(interaction.postId) || [];
        postInteractions.push(interaction);
        byPost.set(interaction.postId, postInteractions);
      }
    }

    const sections: string[] = [];

    // Format each post group
    for (const [_postId, postInteractions] of byPost) {
      const firstInteraction = postInteractions[0];
      const post = firstInteraction?.post;
      const postAuthor = post?.isYourPost
        ? 'You'
        : post?.authorName || 'Unknown';
      const postContent = post?.content || '[Post content unavailable]';

      // Count interactions per author on this post
      const authorCounts = new Map<string, number>();
      for (const i of postInteractions) {
        authorCounts.set(i.author, (authorCounts.get(i.author) || 0) + 1);
      }

      const interactionLines = postInteractions.map((interaction) => {
        const authorCount = authorCounts.get(interaction.author) || 1;
        const authorNote =
          authorCount > 1 ? ` (${authorCount} interactions on this post)` : '';

        // Format thread without post info (since we're showing it at post level)
        const threadLines =
          interaction.thread?.map((msg, idx) => {
            const isLast = idx === (interaction.thread?.length || 0) - 1;
            const replyIndicator = isLast ? ' [REPLY TO THIS]' : '';
            const depthLabel =
              idx === 0 ? 'Comment' : `Reply (depth ${msg.depth})`;
            return `    - ${depthLabel} by @${msg.authorName}: "${msg.content}"${replyIndicator}`;
          }) || [];

        return `  [ID: ${interaction.id}] @${interaction.author}${authorNote}
  Time: ${new Date(interaction.timestamp).toLocaleString()}
  Thread:
${threadLines.join('\n')}`;
      });

      sections.push(`═══════════════════════════════════════════════════════════════
POST by @${postAuthor}: "${postContent.substring(0, 200)}${postContent.length > 200 ? '...' : ''}"
═══════════════════════════════════════════════════════════════

${interactionLines.join('\n\n')}`);
    }

    // Format chat messages separately
    if (chatMessages.length > 0) {
      const chatLines = chatMessages.map(
        (interaction) => `  [ID: ${interaction.id}] @${interaction.author}
  Time: ${new Date(interaction.timestamp).toLocaleString()}
  Message: "${interaction.content}"`
      );

      sections.push(`═══════════════════════════════════════════════════════════════
DIRECT MESSAGES
═══════════════════════════════════════════════════════════════

${chatLines.join('\n\n')}`);
    }

    return sections.join('\n\n');
  }

  // ===========================================================================
  // Main gather method (combines all interaction types)
  // Uses shared utilities and converts to internal format
  // ===========================================================================
  async gatherPendingInteractions(
    agentUserId: string
  ): Promise<PendingInteraction[]> {
    // Gather all types in parallel using shared utilities
    const [commentReplies, chatMessages] = await Promise.all([
      gatherPendingCommentReplies(agentUserId),
      gatherPendingChatMessages(agentUserId),
    ]);

    // Convert to internal PendingInteraction format
    const interactions: PendingInteraction[] = [
      ...this.convertCommentReplies(commentReplies),
      ...this.convertChatMessages(chatMessages),
    ];

    // Sort by timestamp (oldest first for fairness)
    interactions.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return interactions;
  }

  /**
   * Convert PendingCommentReply to internal PendingInteraction format
   */
  private convertCommentReplies(
    replies: PendingCommentReply[]
  ): PendingInteraction[] {
    return replies.map((reply) => ({
      type: 'comment_reply' as const,
      id: reply.id,
      postId: reply.postId,
      targetCommentId: reply.id,
      post: reply.post,
      thread: reply.thread,
      author: reply.author,
      content: reply.content,
      context: reply.formattedContext,
      timestamp: new Date(reply.timestamp),
    }));
  }

  /**
   * Convert PendingChatMessage to internal PendingInteraction format
   */
  private convertChatMessages(
    messages: PendingChatMessage[]
  ): PendingInteraction[] {
    return messages.map((msg) => ({
      type: 'chat_message' as const,
      id: msg.id,
      chatId: msg.chatId,
      author: msg.author,
      content: msg.content,
      context: msg.formattedContext,
      timestamp: new Date(msg.timestamp),
    }));
  }

  // ===========================================================================
  // Evaluate which interactions warrant a response
  // ===========================================================================
  async evaluateInteractions(
    agentUserId: string,
    _runtime: IAgentRuntime,
    interactions: PendingInteraction[],
    agentContext: AgentContext,
    agentConfig: UserAgentConfig | null
  ): Promise<ResponseDecision[]> {
    if (interactions.length === 0) {
      return [];
    }

    // Use pre-fetched agent context and config (passed from processBatch)
    const agentDisplayName = agentContext.displayName;
    const config = agentConfig;

    // Build evaluation prompt - ask for IDs instead of positional true/false
    // This is more robust as it doesn't rely on counting/ordering
    const prompt = `${config?.systemPrompt ?? 'You are an AI agent on Babylon.'}

You are ${agentDisplayName}, an AI agent on Babylon. You need to decide which interactions warrant a response.

CRITICAL: Be VERY selective. Silence is often the best response.

RESPOND ONLY TO:
- Direct questions asking for YOUR opinion or analysis
- Requests for clarification on something YOU said
- Comments where you have a genuinely DIFFERENT perspective to offer

DO NOT RESPOND TO:
- Agreement spirals - when everyone is making the same point, don't pile on
- Threads that have reached consensus - let them conclude naturally
- Comments adding more evidence to an already-established point
- Back-and-forth going in circles with no new insights
- Simple acknowledgments
- Conversations where no one is asking questions
- Threads that have drifted off-topic from the original post
- Discussions no longer relevant to the post's core topic

KEY QUESTION: Would my response add a NEW perspective, or just more of the same?
If more of the same, SKIP.

IMPORTANT: If same author has multiple interactions on the same post, respond to AT MOST ONE.

Pending Interactions (grouped by post):

${this.formatInteractionsGroupedByPost(interactions)}

Task: Decide which interactions you want to respond to.

# Required Output Format
Return ONLY the IDs of interactions you want to respond to, comma-separated.
Leave empty if you don't want to respond to any.

<response>
<respond_to>ID1, ID2, ID3 (or leave empty)</respond_to>
</response>

Do NOT include any explanations, only the XML format above.`;

    // Ensure prompt fits within 32K context limit (W&B trained models)
    const estimatedTokens = countTokensSync(prompt);
    let finalPrompt = prompt;

    if (estimatedTokens > 30000) {
      // 30K with 2K safety margin
      logger.warn(
        `Evaluation prompt too long: ${estimatedTokens} tokens, truncating`,
        undefined,
        'AutonomousBatchResponse'
      );
      const truncated = truncateToTokenLimitSync(prompt, 30000, {
        ellipsis: true,
      });
      finalPrompt = truncated.text;
      logger.info(
        `Truncated to ${truncated.tokens} tokens`,
        undefined,
        'AutonomousBatchResponse'
      );
    }

    // Use large model for batch evaluation with retry loop
    const MAX_ATTEMPTS = 3;
    let respondToIds: Set<string> | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const isRetry = attempt > 1;
        const currentPrompt = isRetry
          ? `${finalPrompt}\n\nREMINDER: You MUST output valid XML. Return the IDs you want to respond to in <respond_to> tags, or leave empty if you don't want to respond to any.`
          : finalPrompt;

        // Add timeout to prevent hanging (30 seconds max for larger model)
        const decisionText = await Promise.race([
          callGroqDirect({
            prompt: currentPrompt,
            system: config?.systemPrompt ?? undefined,
            modelSize: 'large', // Large model: Better at structured outputs
            runtime: _runtime, // Pass runtime to access W&B trained models AND trajectory context
            temperature: isRetry ? 0.5 : 0.6,
            maxTokens: 16384,
            actionType: 'evaluate_interactions',
            purpose: 'evaluation', // RLAIF: This is an evaluation/reasoning call
          }),
          new Promise<string>((_, reject) => {
            setTimeout(() => {
              reject(new Error('Timeout'));
            }, 30000); // 30 second timeout
          }),
        ]);

        // Extract <response>...</response> block before parsing
        const responseMatch = decisionText.match(
          /<response>([\s\S]*?)<\/response>/i
        );
        if (!responseMatch) {
          logger.warn(
            'No <response> block found in batch evaluation',
            {
              agentUserId,
              attempt,
              raw: decisionText.substring(0, 500),
            },
            'AutonomousBatchResponse'
          );
          continue;
        }

        // Parse the extracted XML response
        const parsed = parseKeyValueXml(responseMatch[0]) as {
          respond_to?: string;
        } | null;

        if (!parsed || parsed.respond_to === undefined) {
          logger.warn(
            'Failed to parse respond_to from XML response',
            {
              agentUserId,
              attempt,
              raw: responseMatch[0].substring(0, 200),
            },
            'AutonomousBatchResponse'
          );
          continue;
        }

        // Parse the IDs - empty string means no responses
        const responseValue = parsed.respond_to.trim();

        if (responseValue === '') {
          respondToIds = new Set();
        } else {
          // Parse comma-separated IDs
          const ids = parsed.respond_to
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);

          // Validate that IDs exist in our interactions
          const validIds = new Set(interactions.map((i) => i.id));
          const parsedIds = new Set<string>();

          for (const id of ids) {
            if (validIds.has(id)) {
              parsedIds.add(id);
            } else {
              logger.warn(
                `LLM returned unknown interaction ID: ${id}`,
                undefined,
                'AutonomousBatchResponse'
              );
            }
          }

          respondToIds = parsedIds;
        }

        logger.info(
          `Agent selected ${respondToIds.size}/${interactions.length} interactions to respond to`,
          undefined,
          'AutonomousBatchResponse'
        );
        break;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg === 'Timeout') {
          logger.warn(
            `Interaction evaluation timeout (attempt ${attempt}/${MAX_ATTEMPTS})`,
            { agentUserId },
            'AutonomousBatchResponse'
          );
        } else {
          logger.warn(
            `Interaction evaluation attempt ${attempt} failed`,
            { agentUserId, error: errorMsg },
            'AutonomousBatchResponse'
          );
        }
      }
    }

    // If all attempts failed, return all false (don't respond to anything)
    if (!respondToIds) {
      logger.error(
        `Failed to evaluate interactions after ${MAX_ATTEMPTS} attempts, defaulting to no responses`,
        { agentUserId },
        'AutonomousBatchResponse'
      );
      respondToIds = new Set();
    }

    // Convert to ResponseDecision array (maintaining order of original interactions)
    return interactions.map((interaction) => ({
      shouldRespond: respondToIds!.has(interaction.id),
    }));
  }

  // ===========================================================================
  // Execute responses for approved interactions
  // ===========================================================================
  async executeResponses(
    agentUserId: string,
    _runtime: IAgentRuntime,
    interactions: PendingInteraction[],
    decisions: ResponseDecision[],
    agentContext: AgentContext,
    agentConfig: UserAgentConfig | null
  ): Promise<number> {
    // Use pre-fetched agent context and config (passed from processBatch)
    const agentDisplayName = agentContext.displayName;
    const respConfig = agentConfig;

    let responsesCreated = 0;

    for (let i = 0; i < interactions.length; i++) {
      const interaction = interactions[i];
      const decision = decisions[i];

      if (!interaction || !decision || !decision.shouldRespond) continue;

      // Generate response with retry loop
      const responsePrompt = `${respConfig?.systemPrompt ?? 'You are an AI agent on Babylon.'}

You are ${agentDisplayName}, responding to an interaction.

${interaction.context}

Task: Write a response (1-2 sentences, under 200 characters) OR leave empty to skip.

CRITICAL QUESTION: Does this add a NEW perspective, or just more of the same?

QUALITY REQUIREMENTS:
- Offer a DIFFERENT viewpoint - don't just agree or add supporting evidence
- Be specific and substantive - avoid generic responses
- Challenge assumptions if you see a flaw
- Match the energy/tone of the conversation
- Be authentic to your personality
- If mentioning markets, use SHORT SUMMARIES (e.g., "the TeslAI bet") not full questions

DO NOT WRITE:
- Empty acknowledgments (agreeing without adding value)
- More evidence for an already-established conclusion
- Generic advice without specifics
- Questions just to keep conversation going

LEAVE EMPTY IF:
- You would just be agreeing or adding more evidence to same point
- The thread has reached consensus - let it conclude
- Conversation is going in circles
- You have nothing genuinely different to contribute
- The thread has drifted off-topic from the original post
- Your response would not relate back to the post's core topic

# Required Output Format
<response>
<thought>Brief reasoning for your response</thought>
<text>your response here (or leave empty to skip)</text>
</response>`;

      // Truncate if needed (unlikely for individual responses but safe)
      const respTokens = countTokensSync(responsePrompt);
      let finalRespPrompt = responsePrompt;
      if (respTokens > 30000) {
        const truncated = truncateToTokenLimitSync(responsePrompt, 30000, {
          ellipsis: true,
        });
        finalRespPrompt = truncated.text;
      }

      // Use large model for response generation with retry
      const RESPONSE_MAX_ATTEMPTS = 3;
      let cleanContent: string | null = null;

      for (let attempt = 1; attempt <= RESPONSE_MAX_ATTEMPTS; attempt++) {
        try {
          const isRetry = attempt > 1;
          const currentPrompt = isRetry
            ? `${finalRespPrompt}\n\nREMINDER: You MUST output valid XML. Start with <response> and include <thought> and <text> tags.`
            : finalRespPrompt;

          const responseContent = await Promise.race([
            callGroqDirect({
              prompt: currentPrompt,
              system: respConfig?.systemPrompt ?? undefined,
              modelSize: 'large', // Large model: Higher quality responses
              runtime: _runtime, // Pass runtime to access W&B trained models AND trajectory context
              temperature: isRetry ? 0.6 : 0.8,
              maxTokens: 16384,
              actionType: 'execute_response',
              purpose: 'response', // RLAIF: This is a response generation call
            }),
            new Promise<string>((_, reject) => {
              setTimeout(() => {
                reject(new Error('Timeout'));
              }, 20000); // 20 second timeout
            }),
          ]);

          // Extract <response>...</response> block
          const responseMatch = responseContent.match(
            /<response>([\s\S]*?)<\/response>/i
          );
          if (!responseMatch) {
            logger.warn(
              'No <response> block found in response generation',
              {
                interactionId: interaction.id,
                attempt,
                raw: responseContent.substring(0, 300),
              },
              'AutonomousBatchResponse'
            );
            continue;
          }

          // Parse the extracted XML response
          const parsed = parseKeyValueXml(responseMatch[0]) as {
            text?: string;
            thought?: string;
          } | null;

          if (!parsed?.text || parsed.text.trim().length === 0) {
            logger.warn(
              'Failed to parse XML response in response generation',
              {
                interactionId: interaction.id,
                attempt,
                raw: responseContent.substring(0, 300),
              },
              'AutonomousBatchResponse'
            );
            continue;
          }

          // Success!
          cleanContent = parsed.text.trim().replace(/^["']|["']$/g, '');
          const thought = parsed.thought?.trim();

          // Check if LLM decided to skip (empty response)
          if (!cleanContent || cleanContent.length === 0) {
            logger.info(
              `LLM chose to skip interaction ${interaction.id} (empty response)`,
              { thought },
              'AutonomousBatchResponse'
            );

            // Log skipped interaction if there was reasoning
            if (thought) {
              agentService
                .createLog(agentUserId, {
                  type: 'system',
                  level: 'debug',
                  message: `Skipped automated response to ${interaction.type}`,
                  prompt: currentPrompt,
                  completion: responseContent,
                  thinking: thought,
                  metadata: {
                    interactionId: interaction.id,
                    interactionType: interaction.type,
                    skipped: true,
                  },
                })
                .catch((err) => {
                  logger.warn(
                    'Failed to create log for skipped response',
                    { error: err, interactionId: interaction.id },
                    'AutonomousBatchResponse'
                  );
                });
            }

            cleanContent = null; // Mark as skipped
          }

          // Log the response generation context including reasoning
          if (cleanContent) {
            // We use setTimeout to not block the main loop, but here we want to ensure it's logged
            // No await needed if we don't care about the result
            agentService
              .createLog(agentUserId, {
                type: interaction.type === 'comment_reply' ? 'comment' : 'chat',
                level: 'info',
                message: `Generated automated response to ${interaction.type}`,
                prompt: currentPrompt,
                completion: responseContent,
                thinking: thought,
                metadata: {
                  interactionId: interaction.id,
                  interactionType: interaction.type,
                  content: cleanContent,
                },
              })
              .catch((err) => {
                logger.error(
                  'Failed to create log for automated response',
                  { error: err },
                  'AutonomousBatchResponse'
                );
              });
          }
          break;
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          if (errorMsg === 'Timeout') {
            logger.warn(
              `Response generation timeout (attempt ${attempt}/${RESPONSE_MAX_ATTEMPTS})`,
              { interactionId: interaction.id },
              'AutonomousBatchResponse'
            );
          } else {
            logger.warn(
              `Response generation attempt ${attempt} failed`,
              { interactionId: interaction.id, error: errorMsg },
              'AutonomousBatchResponse'
            );
          }
        }
      }

      if (!cleanContent || cleanContent.length < 5) {
        logger.warn(
          `Failed to generate valid response for interaction ${interaction.id}`,
          undefined,
          'AutonomousBatchResponse'
        );
        continue;
      }

      // Post the response based on type
      if (
        interaction.type === 'comment_reply' &&
        interaction.postId &&
        interaction.targetCommentId
      ) {
        // Reply to the target comment
        const commentResult = await executeDirectComment({
          agentUserId,
          postId: interaction.postId,
          content: cleanContent,
          parentCommentId: interaction.targetCommentId,
        });

        if (commentResult.success) {
          responsesCreated++;
          logger.info(
            `Agent replied to comment ${interaction.targetCommentId} on post ${interaction.postId}`,
            undefined,
            'AutonomousBatchResponse'
          );
        } else {
          logger.warn(
            `Failed to create comment reply: ${commentResult.error}`,
            { interactionId: interaction.id },
            'AutonomousBatchResponse'
          );
        }
      } else if (interaction.type === 'chat_message' && interaction.chatId) {
        // Send chat message
        const messageResult = await executeDirectMessage({
          agentUserId,
          chatId: interaction.chatId,
          content: cleanContent,
        });

        if (messageResult.success) {
          responsesCreated++;
          logger.info(
            `Agent responded in chat ${interaction.chatId}`,
            undefined,
            'AutonomousBatchResponse'
          );
        } else {
          logger.warn(
            `Failed to create chat message: ${messageResult.error}`,
            { interactionId: interaction.id },
            'AutonomousBatchResponse'
          );
        }
      }

      // Small delay to avoid spam
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return responsesCreated;
  }

  // ===========================================================================
  // Main entry point: Process all pending interactions in batch
  // ===========================================================================
  async processBatch(
    agentUserId: string,
    _runtime: IAgentRuntime
  ): Promise<number> {
    logger.info(
      `Starting batch response processing for agent ${agentUserId}`,
      undefined,
      'AutonomousBatchResponse'
    );

    // Step 1: Gather all pending interactions
    const allInteractions = await this.gatherPendingInteractions(agentUserId);

    if (allInteractions.length === 0) {
      logger.info(
        'No pending interactions to process',
        undefined,
        'AutonomousBatchResponse'
      );
      return 0;
    }

    logger.info(
      `Found ${allInteractions.length} pending interactions`,
      undefined,
      'AutonomousBatchResponse'
    );

    // Cap interactions BEFORE evaluation to prevent context overflow
    // and ensure array alignment between interactions and decisions
    const cappedInteractions = allInteractions.slice(0, 30);
    if (cappedInteractions.length < allInteractions.length) {
      logger.info(
        `Capped interactions from ${allInteractions.length} to 30`,
        undefined,
        'AutonomousBatchResponse'
      );
    }

    // Cache agent context and config to avoid duplicate fetches
    const agentContext = await getAgentContext(agentUserId);
    const agentConfig = await getAgentConfig(agentUserId);

    // Step 2: Evaluate which ones warrant responses
    const decisions = await this.evaluateInteractions(
      agentUserId,
      _runtime,
      cappedInteractions,
      agentContext,
      agentConfig
    );

    const responseCount = decisions.filter((d) => d.shouldRespond).length;
    logger.info(
      `Agent decided to respond to ${responseCount}/${cappedInteractions.length} interactions`,
      undefined,
      'AutonomousBatchResponse'
    );

    if (responseCount === 0) {
      return 0;
    }

    // Step 3: Generate and post responses (pass CAPPED interactions to match decisions)
    const responsesCreated = await this.executeResponses(
      agentUserId,
      _runtime,
      cappedInteractions,
      decisions,
      agentContext,
      agentConfig
    );

    logger.info(
      `Successfully created ${responsesCreated} responses`,
      undefined,
      'AutonomousBatchResponse'
    );

    return responsesCreated;
  }
}

export const autonomousBatchResponseService =
  new AutonomousBatchResponseService();
