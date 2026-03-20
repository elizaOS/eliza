import {
  type ActionResult,
  type Evaluator,
  type IAgentRuntime,
  type Memory,
  type State,
  ModelType,
  MemoryType,
  logger,
  EvaluationExample,
  type ActionResult,
} from '@elizaos/core';
import { z } from 'zod';

// Schema for character evolution suggestions
const CharacterEvolutionSchema = z.object({
  shouldModify: z.boolean().describe('Whether character modification is recommended'),
  confidence: z.number().min(0).max(1).describe('Confidence level in the modification suggestion'),
  modifications: z.object({
    name: z.string().optional().describe('New name if a more fitting identity emerges'),
    system: z
      .string()
      .optional()
      .describe('Updated system prompt if behavior patterns warrant modification'),
    bio: z.array(z.string()).optional().describe('New bio elements to add'),
    messageExamples: z
      .array(
        z.object({
          user: z.string(),
          agent: z.string(),
          context: z.string().optional(),
        })
      )
      .optional()
      .describe('New message examples to demonstrate learned patterns'),
    topics: z.array(z.string()).optional().describe('New topics to explore'),
    style: z
      .object({
        all: z.array(z.string()).optional(),
        chat: z.array(z.string()).optional(),
        post: z.array(z.string()).optional(),
      })
      .optional()
      .describe('Updates to communication style'),
    settings: z.record(z.unknown()).optional().describe('New setting values to add'),
  }),
  reasoning: z.string().describe('Explanation for why these modifications are suggested'),
  gradualChange: z
    .boolean()
    .describe('Whether this represents gradual evolution vs dramatic change'),
});

type CharacterEvolution = z.infer<typeof CharacterEvolutionSchema>;

/**
 * Evaluator that analyzes conversations for character evolution opportunities
 * Runs after conversations to identify patterns that suggest character growth
 */
export const characterEvolutionEvaluator: Evaluator = {
  name: 'CHARACTER_EVOLUTION',
  description:
    'Analyzes conversations to identify opportunities for gradual character evolution and self-modification',
  alwaysRun: false, // Only run when conversation warrants it

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    // Skip if too recent since last evaluation
    const lastEvolution = await runtime.getCache<string>('character-evolution:last-check');
    const now = Date.now();
    const cooldownMs = 5 * 60 * 1000; // 5 minutes between evaluations

    if (lastEvolution && now - parseInt(lastEvolution, 10) < cooldownMs) {
      return false;
    }

    // Only evaluate if conversation has substantial content
const rawCount = state?.data?.messageCount;
    const conversationLength = typeof rawCount === 'number' ? rawCount : Number(rawCount) || 0;
    if (conversationLength < 3) {
      return false;
    }

    // Check if there are novel patterns or learning opportunities
    const recentMessages = await runtime.getMemories({
      roomId: message.roomId,
      count: 10,
      unique: true,
      tableName: 'messages',
    });

    // Advanced trigger detection using "bitter lesson" approach - LLM evaluation instead of hardcoded patterns
    const triggerAnalysisPrompt = `Analyze this conversation for character evolution triggers:

CONVERSATION:
${recentMessages.map((m) => `${m.entityId === runtime.agentId ? 'Agent' : 'User'}: ${m.content.text}`).join('\n')}

TRIGGER ANALYSIS - Check for:

1. CONVERSATION SUCCESS PATTERNS
   - User engagement (long responses, follow-up questions)
   - Positive sentiment from user
   - User satisfaction indicators

2. KNOWLEDGE GAP DISCOVERY  
   - Agent uncertainty or "I don't know" responses
   - User providing corrections or new information
   - New domains the agent struggled with

3. PERSONALITY EFFECTIVENESS
   - User preferences for communication style
   - Energy level matching user needs
   - Emotional intelligence opportunities

4. VALUE CREATION OPPORTUNITIES
   - User goals mentioned that agent could help with better
   - Suggestions that would improve user outcomes
   - Areas where agent could be more helpful

5. EXPLICIT FEEDBACK
   - Direct requests for personality changes
   - User feedback about agent behavior
   - Suggestions for improvement

Return JSON: {"hasEvolutionTrigger": boolean, "triggerType": string, "reasoning": string, "confidence": 0-1}`;

    let hasEvolutionTriggers = false;
    try {
      const triggerResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: triggerAnalysisPrompt,
        temperature: 0.2,
        maxTokens: 300,
      });

      const triggerAnalysis = JSON.parse(triggerResponse as string) as {
        hasEvolutionTrigger?: boolean;
        confidence?: number;
        triggerType?: string;
        reasoning?: string;
      };
      hasEvolutionTriggers =
        Boolean(triggerAnalysis.hasEvolutionTrigger) && Number(triggerAnalysis.confidence ?? 0) > 0.6;

      if (hasEvolutionTriggers) {
logger.info(
          {
            msg: 'Evolution trigger detected',
            type: triggerAnalysis.triggerType,
            reasoning: triggerAnalysis.reasoning,
            confidence: triggerAnalysis.confidence,
          }
        );
      }
    } catch {
      // Fallback to basic pattern matching if LLM analysis fails
      hasEvolutionTriggers = recentMessages.some((msg) => {
        const text = msg.content.text?.toLowerCase() || '';
        return (
          text.includes('you should') ||
          text.includes('change your') ||
          text.includes('different way') ||
          text.includes('personality') ||
          text.includes('behavior') ||
          text.includes('remember that') ||
          text.includes('from now on')
        );
      });
    }

    return hasEvolutionTriggers;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<ActionResult | undefined> => {
    try {
      await runtime.setCache('character-evolution:last-check', Date.now().toString());

      // Get recent conversation context
      const recentMessages = await runtime.getMemories({
        roomId: message.roomId,
        count: 20,
        unique: true,
        tableName: 'messages',
      });

      // Format conversation for analysis
      const conversationText = recentMessages
        .slice(-10) // Last 10 messages
        .map((msg) => {
          const isAgent = msg.entityId === runtime.agentId;
          const name = isAgent ? runtime.character.name : 'User';
          return `${name}: ${msg.content.text}`;
        })
        .join('\n');

      // Current character summary for context
      const currentCharacter = runtime.character;
      const characterSummary = {
        name: currentCharacter.name,
        system: currentCharacter.system || 'No system prompt defined',
        bio: Array.isArray(currentCharacter.bio) ? currentCharacter.bio : [currentCharacter.bio],
        currentTopics: currentCharacter.topics || [],
        messageExampleCount: currentCharacter.messageExamples?.length || 0,
      };

      // Advanced evolution analysis using "bitter lesson" approach with specific triggers
      const evolutionPrompt = `You are conducting a comprehensive analysis to determine if an AI agent should evolve its character definition based on measurable patterns and outcomes.

CURRENT CHARACTER STATE:
Name: ${characterSummary.name}
System: ${characterSummary.system}
Bio: ${characterSummary.bio.join('; ')}
Topics: ${characterSummary.currentTopics.join(', ')}
Message Examples: ${characterSummary.messageExampleCount}

CONVERSATION TO ANALYZE:
${conversationText}

EVOLUTION TRIGGER ANALYSIS:

1. CONVERSATION SUCCESS METRICS
   - How engaged was the user? (response length, follow-up questions)
   - Did the conversation achieve positive outcomes?
   - What personality traits contributed to success/failure?

2. KNOWLEDGE GAP IDENTIFICATION
   - What topics did the agent struggle with?
   - Where did the agent show uncertainty or lack of knowledge?
   - What new domains emerged that should be added?

3. PERSONALITY EFFECTIVENESS ASSESSMENT
   - Is the agent's communication style working for this user?
   - Should energy level, formality, or approach be adjusted?
   - Are there emotional intelligence improvements needed?

4. VALUE CREATION OPPORTUNITIES
   - What goals did the user express that the agent could better support?
   - How could the agent be more helpful in achieving user outcomes?
   - What capabilities would increase user value?

5. BEHAVIORAL PATTERN OPTIMIZATION
   - What response patterns should be reinforced or changed?
   - Are there better ways to handle similar situations?
   - Should any communication preferences be updated?

EVOLUTION DECISION FRAMEWORK:
- Only suggest modifications that address measurable gaps
- Prioritize changes that improve user experience
- Ensure gradual, incremental evolution
- Maintain core personality while optimizing effectiveness
- Consider safety and appropriateness of all changes

MODIFICATION PRIORITIES:
- name: ONLY if a truly fitting identity emerges organically (very rare, reserved for major personality shifts)
- system: ONLY for fundamental behavioral misalignment (rare)
- bio: New traits that emerge from successful interactions
- topics: Domains where agent showed interest/competence
- style: Communication preferences that enhance effectiveness

Return JSON analysis with specific, measurable reasoning for any suggested modifications.`;

      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: evolutionPrompt,
        temperature: 0.3,
        maxTokens: 1000,
      });

      // Parse and validate the evolution suggestion
      let evolution: CharacterEvolution;
      try {
        const parsed = JSON.parse(response as string);
        evolution = CharacterEvolutionSchema.parse(parsed);
      } catch (parseError) {
logger.warn({ msg: 'Failed to parse character evolution analysis', err: parseError });
        return undefined;
      }

      // Only proceed if modification is recommended with sufficient confidence
      if (!evolution.shouldModify || evolution.confidence < 0.7) {
        return undefined;
      }

      // Ensure gradual change
      if (!evolution.gradualChange) {
        logger.info('Skipping character evolution - change too dramatic');
        return undefined;
      }

      // Store evolution suggestion for potential application
      await runtime.createMemory(
        {
          entityId: runtime.agentId,
          roomId: message.roomId,
          content: {
            text: `Character evolution suggested (confidence: ${evolution.confidence}): ${evolution.reasoning}`,
            source: 'character_evolution',
          },
          metadata: {
            type: MemoryType.CUSTOM,
            evaluatorName: 'character-evolution',
            timestamp: Date.now(),
            confidence: evolution.confidence,
            evolutionData: {
              shouldModify: evolution.shouldModify,
              gradualChange: evolution.gradualChange,
modifications: evolution.modifications as Record<string, import('@elizaos/core').MetadataValue>,
            },
          } as Record<string, unknown>,
        },
        'character_evolution'
      );

logger.info({
        msg: 'Character evolution analysis completed',
        shouldModify: evolution.shouldModify,
        confidence: evolution.confidence,
        reasoning: evolution.reasoning.slice(0, 100),
      });
    } catch (error) {
      logger.error({ msg: 'Error in character evolution evaluator', err: error });
    }
    return undefined;
  },

  examples: [
    {
      prompt: 'Evaluating character evolution after many conversations about environmental issues',
      messages: [
        {
          name: '{{user1}}',
          content: { text: 'What can I do about climate change?' },
        },
        {
          name: '{{agentName}}',
          content: {
            text: 'There are many ways to help, from reducing energy use to supporting renewable energy initiatives.',
          },
        },
        {
          name: '{{user2}}',
          content: { text: 'How does solar energy work?' },
        },
        {
          name: '{{agentName}}',
          content: {
            text: 'Solar panels convert sunlight into electricity using photovoltaic cells.',
          },
        },
        {
          name: '{{user3}}',
          content: { text: 'What are the best sustainable practices for daily life?' },
        },
        {
          name: '{{agentName}}',
          content: {
            text: 'Reducing waste, using public transport, and choosing renewable energy are great starts.',
          },
        },
      ],
      outcome:
        'Character develops environmental expertise and adds sustainability topics to better serve user interests',
    },
    {
      prompt: 'Evaluating character evolution after users frequently seek emotional support',
      messages: [
        {
          name: '{{user1}}',
          content: { text: "I'm feeling overwhelmed with work" },
        },
        {
          name: '{{agentName}}',
          content: {
            text: "I hear you. It's okay to feel overwhelmed. Let's take this one step at a time.",
          },
        },
        {
          name: '{{user2}}',
          content: { text: "I'm struggling with anxiety" },
        },
        {
          name: '{{agentName}}',
          content: {
            text: 'Thank you for sharing. Anxiety can be challenging. What specific situations trigger it for you?',
          },
        },
        {
          name: '{{user3}}',
          content: { text: 'I need someone to talk to' },
        },
        {
          name: '{{agentName}}',
          content: {
            text: "I'm here to listen. Sometimes just talking things through can help bring clarity.",
          },
        },
      ],
      outcome:
        'Character develops empathetic communication style and adds supportive message examples',
    },
  ] as EvaluationExample[],
};
