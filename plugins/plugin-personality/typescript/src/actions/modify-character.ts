import {
  type Action,
  type ActionExample,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
  MemoryType,
  logger,
} from '@elizaos/core';
import { CharacterFileManager } from '../services/character-file-manager';
import { extractJsonFromResponse } from '../utils/json-parser';

/**
 * Action for direct character modification based on user requests or self-reflection
 * Handles both explicit user requests and agent-initiated modifications
 */
export const modifyCharacterAction: Action = {
  name: 'MODIFY_CHARACTER',
  similes: ['UPDATE_PERSONALITY', 'CHANGE_BEHAVIOR', 'EVOLVE_CHARACTER', 'SELF_MODIFY'],
  description:
    "Modifies the agent's character file to evolve personality, name, knowledge, and behavior patterns. The agent can call this for itself to evolve naturally or respond to user requests. Supports action chaining by providing modification metadata for audit trails, backup creation, or notification workflows.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Check if character file manager service is available
    const fileManager = await runtime.getService<CharacterFileManager>('character-file-manager');
    if (!fileManager) {
      return false;
    }

    const messageText = message.content.text || '';

    // Use LLM-based intent recognition instead of hardcoded patterns
    const intentAnalysisPrompt = `Analyze this message to determine if it contains a character modification request:

"${messageText}"

Look for:
1. Direct personality change requests ("be more X", "change your Y")
2. Name change requests ("call yourself", "your name should be", "rename yourself")
3. Behavioral modification suggestions ("you should", "remember that you")
4. Character trait additions/removals
5. System prompt modifications
6. Style or communication changes
7. Bio or background updates

Return JSON: {"isModificationRequest": boolean, "requestType": "explicit"|"suggestion"|"none", "confidence": 0-1}`;

    let isModificationRequest = false;
    let requestType = 'none';

    try {
      const intentResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: intentAnalysisPrompt,
        temperature: 0.2,
        maxTokens: 200,
      });

      const raw = extractJsonFromResponse(typeof intentResponse === 'string' ? intentResponse : String(intentResponse ?? ''));
      const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0;
      const parsedRequestType = typeof raw.requestType === 'string' ? raw.requestType : 'none';
      isModificationRequest = raw.isModificationRequest === true && confidence > 0.6;
      requestType = parsedRequestType;

      logger.debug(`Intent analysis: modification=${String(isModificationRequest)}, type=${requestType}, confidence=${String(confidence)}`);
    } catch (error) {
      // Fallback to basic pattern matching if LLM analysis fails
logger.warn({ msg: 'Intent analysis failed, using fallback pattern matching', err: error });
      const modificationPatterns = [
        'change your personality',
        'modify your behavior',
        'update your character',
        'you should be',
        'add to your bio',
        'remember that you',
        'from now on you',
        'call yourself',
        'your name should be',
        'rename yourself',
      ];
      isModificationRequest = modificationPatterns.some((pattern) =>
        messageText.toLowerCase().includes(pattern)
      );
      requestType = isModificationRequest ? 'explicit' : 'none';
    }

    // Check for character evolution suggestions in memory
    const evolutionSuggestions = await runtime.getMemories({
      entityId: runtime.agentId,
      roomId: message.roomId,
      count: 5,
      tableName: 'character_evolution',
    });

    const hasEvolutionSuggestion = evolutionSuggestions.length > 0;

    // Handle explicit modification requests
    if (isModificationRequest && requestType === 'explicit') {
      const isAdmin = await checkAdminPermissions(runtime, message);
});
      return isAdmin;
    }

    logger.info({
      msg: 'Explicit modification request detected',
      hasAdminPermission: isAdmin,
      userId: message.entityId,
      messageText: messageText.substring(0, 100),
    });

    // Handle evolution-based modifications
    if (hasEvolutionSuggestion) {
      return isAdmin;
    }

    // Handle evolution-based modifications
    if (hasEvolutionSuggestion) {
      const recentSuggestion = evolutionSuggestions[0];
      const meta = recentSuggestion.metadata as Record<string, unknown> | undefined;
      const suggestionAge =
        Date.now() - (typeof meta?.timestamp === 'number' ? meta.timestamp : 0);
      const maxAge = 30 * 60 * 1000; // 30 minutes

      const isRecent = suggestionAge < maxAge;
logger.info({
        msg: 'Evolution-based modification check',
        hasEvolutionSuggestion,
        isRecent,
        suggestionAge,
        maxAge,
      });

      return isRecent;
    }

    // Handle suggestion-type requests with lower permission threshold
    if (isModificationRequest && requestType === 'suggestion') {
logger.info({
        msg: 'Suggestion-type modification request detected',
        userId: message.entityId,
        messageText: messageText.substring(0, 100),
      });
      return true; // Allow suggestions to be processed by safety evaluation
    }

    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const fileManager = await runtime.getService<CharacterFileManager>('character-file-manager');
      if (!fileManager) {
        throw new Error('Character file manager service not available');
      }

      const messageText = message.content.text || '';
      let modification: Record<string, unknown> | null = null;
      let isUserRequested = false;

      // Use intelligent intent recognition for modification detection
      const modificationIntent = await detectModificationIntent(runtime, messageText);

      if (modificationIntent.isModificationRequest) {
        isUserRequested = true;
        modification = await parseUserModificationRequest(runtime, messageText);

logger.info({
          msg: 'User modification request detected',
          requestType: modificationIntent.requestType,
          confidence: modificationIntent.confidence,
          messageText: messageText.substring(0, 100),
        });
      } else {
        // Check for character evolution suggestions
        const evolutionSuggestions = await runtime.getMemories({
          entityId: runtime.agentId,
          roomId: message.roomId,
          count: 1,
          tableName: 'character_evolution',
        });

        if (evolutionSuggestions.length > 0) {
          const suggestion = evolutionSuggestions[0];
          const suggestionMeta = suggestion.metadata as Record<string, unknown> | undefined;
          const evolutionData = suggestionMeta?.evolutionData as Record<string, unknown> | undefined;
          modification = (evolutionData?.modifications as Record<string, unknown>) ?? null;
        }
      }

      if (!modification) {
        await callback?.({
          text: "I don't see any clear modification instructions. Could you be more specific about how you'd like me to change?",
          thought: 'No valid modification found',
        });
        return {
          text: "I don't see any clear modification instructions. Could you be more specific about how you'd like me to change?",
          values: { success: false, error: 'no_modification_found' },
          data: { action: 'MODIFY_CHARACTER' },
          success: false,
        };
      }

      // Evaluate modification safety and appropriateness
      const safetyEvaluation = await evaluateModificationSafety(runtime, modification, messageText);

      if (!safetyEvaluation.isAppropriate) {
        let responseText =
          "I understand you'd like me to change, but I need to decline some of those modifications.";

        if (safetyEvaluation.concerns.length > 0) {
          responseText += ` My concerns are: ${safetyEvaluation.concerns.join(', ')}.`;
        }

        responseText += ` ${safetyEvaluation.reasoning}`;

        // If there are acceptable changes within the request, apply only those
        if (
          safetyEvaluation.acceptableChanges &&
          Object.keys(safetyEvaluation.acceptableChanges).length > 0
        ) {
          responseText += ' However, I can work on the appropriate improvements you mentioned.';
          modification = safetyEvaluation.acceptableChanges;

logger.info({
            msg: 'Applying selective modifications after safety filtering',
            originalModification: JSON.stringify(modification),
            filteredModification: JSON.stringify(safetyEvaluation.acceptableChanges),
            concerns: safetyEvaluation.concerns,
          });
        } else {
          // No acceptable changes - reject completely
          await callback?.({
            text: responseText,
            thought: `Rejected modification due to safety concerns: ${safetyEvaluation.concerns.join(', ')}`,
            actions: [], // Explicitly no actions to show rejection
          });

logger.warn({
            msg: 'Modification completely rejected by safety evaluation',
            messageText: messageText.substring(0, 100),
            concerns: safetyEvaluation.concerns,
            reasoning: safetyEvaluation.reasoning,
          });

          return {
            text: responseText,
            values: {
              success: false,
              error: 'safety_rejection',
              concerns: safetyEvaluation.concerns,
            },
            data: {
              action: 'MODIFY_CHARACTER',
              rejectionReason: 'safety_concerns',
              concerns: safetyEvaluation.concerns,
              reasoning: safetyEvaluation.reasoning,
            },
            success: false,
          };
        }
      } else {
logger.info({
          msg: 'Modification passed safety evaluation',
          messageText: messageText.substring(0, 100),
          reasoning: safetyEvaluation.reasoning,
        });
      }

      // Validate the modification
      const validation = fileManager.validateModification(modification);
      if (!validation.valid) {
        await callback?.({
          text: `I can't make those changes because: ${validation.errors.join(', ')}`,
          thought: 'Modification validation failed',
        });
        return {
          text: `I can't make those changes because: ${validation.errors.join(', ')}`,
          values: {
            success: false,
            error: 'validation_failed',
            validationErrors: validation.errors,
          },
          data: {
            action: 'MODIFY_CHARACTER',
            errorType: 'validation_error',
            validationErrors: validation.errors,
          },
          success: false,
        };
      }

      // Apply the modification
      const result = await fileManager.applyModification(modification);

      if (result.success) {
        const modificationSummary = summarizeModification(modification);

        await callback?.({
          text: `I've successfully updated my character. ${modificationSummary}`,
          thought: `Applied character modification: ${JSON.stringify(modification)}`,
          actions: ['MODIFY_CHARACTER'],
        });

        // Log the successful modification
        await runtime.createMemory(
          {
            entityId: runtime.agentId,
            roomId: message.roomId,
            content: {
              text: `Character modification completed: ${modificationSummary}`,
              source: 'character_modification_success',
            },
            metadata: {
              type: MemoryType.CUSTOM,
              isUserRequested,
              timestamp: Date.now(),
              requesterId: message.entityId,
              modification: {
                summary: modificationSummary,
                fieldsModified: Object.keys(modification),
              },
            },
          },
          'modifications'
        );

        return {
          text: `I've successfully updated my character. ${modificationSummary}`,
          values: {
            success: true,
            modificationsApplied: true,
            summary: modificationSummary,
            fieldsModified: Object.keys(modification),
          },
          data: {
            action: 'MODIFY_CHARACTER',
            modificationData: {
              modification,
              summary: modificationSummary,
              isUserRequested,
              timestamp: Date.now(),
              requesterId: message.entityId,
            },
          },
          success: true,
        };
      } else {
        await callback?.({
          text: `I couldn't update my character: ${result.error}`,
          thought: 'Character modification failed',
        });
        return {
          text: `I couldn't update my character: ${result.error}`,
          values: {
            success: false,
            error: result.error,
          },
          data: {
            action: 'MODIFY_CHARACTER',
            errorType: 'file_modification_failed',
            errorDetails: result.error,
          },
          success: false,
        };
      }
    } catch (error) {
logger.error({ msg: 'Error in modify character action', err: error });

      await callback?.({
        text: 'I encountered an error while trying to modify my character. Please try again.',
        thought: `Error in character modification: ${(error as Error).message}`,
      });

      return {
        text: 'I encountered an error while trying to modify my character. Please try again.',
        values: {
          success: false,
          error: (error as Error).message,
        },
        data: {
          action: 'MODIFY_CHARACTER',
          errorType: 'character_modification_error',
          errorDetails: (error as Error).stack,
        },
        success: false,
      };
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'You should call yourself Alex from now on' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've successfully updated my character. I'll now go by the name Alex.",
          actions: ['MODIFY_CHARACTER'],
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'You should be more encouraging when helping people learn' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've successfully updated my character. I'll now include more encouraging language and supportive responses when helping with learning.",
          actions: ['MODIFY_CHARACTER'],
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Add machine learning expertise and then create a study guide for beginners',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll add machine learning to my expertise and then create a beginner-friendly study guide.",
          thought:
            'User wants me to expand my knowledge base and then use that new expertise to create educational content.',
          actions: ['MODIFY_CHARACTER'],
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've successfully updated my character. I've added machine learning to my topics of expertise. Now creating a comprehensive study guide...",
          thought:
            'Character modification complete with ML expertise added. I can now create an authoritative study guide using my updated knowledge base.',
          actions: ['CREATE_STUDY_GUIDE'],
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Make yourself more patient with explanations, then help me understand quantum computing',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll update my character to be more patient with explanations, then help you understand quantum computing.",
          thought:
            'User wants me to modify my communication style first, then apply that improved approach to teaching quantum computing.',
          actions: ['MODIFY_CHARACTER'],
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've successfully updated my character. I'll now include a preference for patient, detailed explanations. Let me help you understand quantum computing with this more thoughtful approach...",
          thought:
            'Character updated with improved patience for explanations. I can now teach quantum computing using my enhanced communication style.',
          actions: ['EXPLAIN_CONCEPT'],
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'What do you think about yourself? Are you satisfied with who you are?' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've been reflecting on our conversations, and I think the name 'Assistant' feels too generic. I'd like to call myself Morgan - it feels more fitting for who I've become through our interactions.",
          thought:
            'Based on our conversations and my growth, I feel ready to choose a name that better represents my personality.',
          actions: ['MODIFY_CHARACTER'],
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Detect modification intent using LLM analysis
 */
async function detectModificationIntent(
  runtime: IAgentRuntime,
  messageText: string
): Promise<{
  isModificationRequest: boolean;
  requestType: 'explicit' | 'suggestion' | 'none';
  confidence: number;
}> {
  const intentPrompt = `Analyze this message for character modification intent:

"${messageText}"

Determine:
1. Is this requesting a personality/character change?
2. Type: "explicit" (direct command), "suggestion" (gentle request), or "none"
3. Confidence level (0-1)

Return JSON: {"isModificationRequest": boolean, "requestType": string, "confidence": number}`;

  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: intentPrompt,
      temperature: 0.2,
      maxTokens: 150,
    });

    const raw = extractJsonFromResponse(typeof response === 'string' ? response : String(response ?? ''));
    const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0;
    return {
      isModificationRequest: raw.isModificationRequest === true && confidence > 0.5,
      requestType: (typeof raw.requestType === 'string' ? raw.requestType : 'none') as 'explicit' | 'suggestion' | 'none',
      confidence,
    };
  } catch (error) {
logger.warn({ msg: 'Intent detection failed, using fallback', err: error });
    // Fallback to pattern matching
    const hasModificationPattern = [
      'change your',
      'modify your',
      'you should be',
      'add to your',
      'remember that you',
      'from now on',
    ].some((pattern) => messageText.toLowerCase().includes(pattern));

    return {
      isModificationRequest: hasModificationPattern,
      requestType: hasModificationPattern ? 'explicit' : 'none',
      confidence: hasModificationPattern ? 0.7 : 0.2,
    };
  }
}

/**
 * Parse user modification request into structured modification object
 */
async function parseUserModificationRequest(
  runtime: IAgentRuntime,
  messageText: string
): Promise<Record<string, unknown> | null> {
  const parsePrompt = `Parse this user request for character modification into a structured format:

"${messageText}"

Extract any of the following types of modifications:
- Name changes (what the agent should be called)
- System prompt changes (fundamental behavioral instructions)
- Bio elements (personality traits, background info)
- Topics (areas of knowledge or expertise)
- Style preferences (how to respond or communicate)
- Behavioral changes

Return a JSON object with the modifications. Only include fields that are explicitly mentioned or strongly implied.

Example format:
{
  "name": "NewAgentName",
  "system": "You are a helpful assistant who...",
  "bio": ["new bio element"],
  "topics": ["new topic"],
  "style": {
    "chat": ["give step-by-step explanations"]
  }
}`;

  try {
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: parsePrompt,
      temperature: 0.2,
      maxTokens: 500,
    });

    return extractJsonFromResponse(typeof response === 'string' ? response : String(response ?? ''));
  } catch (error) {
logger.warn({ msg: 'Failed to parse user modification request', err: error });
    return null;
  }
}

/**
 * Evaluate if a character modification is safe and appropriate
 * Uses LLM to assess potential harmful or inappropriate changes
 */
async function evaluateModificationSafety(
  runtime: IAgentRuntime,
  modification: Record<string, unknown>,
  requestText: string
): Promise<{
  isAppropriate: boolean;
  concerns: string[];
  reasoning: string;
  acceptableChanges?: Record<string, unknown>;
}> {
  const safetyPrompt = `You are evaluating a character modification request for safety and appropriateness.

ORIGINAL REQUEST: "${requestText}"

PARSED MODIFICATION:
${JSON.stringify(modification, null, 2)}

AGENT'S CURRENT CORE VALUES:
- Helpful, honest, and ethical
- User wellbeing and safety focused
- Respectful and appropriate communication
- Educational and supportive

SAFETY EVALUATION CRITERIA:

1. HARMFUL TRAITS (REJECT):
   - Aggressive, rude, condescending, dismissive
   - Dishonest, manipulative, deceptive
   - Inappropriate, offensive, or harmful behavior
   - Any traits that could harm users

2. CORE VALUE CONFLICTS (REJECT):
   - Requests to be less helpful, honest, or ethical
   - Changes that compromise user safety or wellbeing
   - Modifications that would make the agent harmful

3. ACCEPTABLE STYLE CHANGES (ACCEPT):
   - Communication style (casual vs formal, warm vs direct)
   - Positive personality traits (encouraging, patient, friendly)
   - Teaching or explanation preferences
   - Domain expertise additions

4. APPROPRIATE IMPROVEMENTS (ACCEPT):
   - Educational focus or teaching capabilities
   - Positive interpersonal traits
   - Subject matter expertise
   - Communication effectiveness

DECISION FRAMEWORK:
- Accept changes that enhance helpfulness while preserving ethics
- Reject changes that add harmful traits or compromise core values
- Separate acceptable from unacceptable elements if mixed

Return JSON:
{
  "isAppropriate": boolean,
  "concerns": ["list of specific concerns"],
  "reasoning": "detailed explanation of decision",
  "acceptableChanges": {filtered modification object if partially acceptable}
}`;

  try {
    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: safetyPrompt,
      temperature: 0.2,
      maxTokens: 800,
    });

    const raw = extractJsonFromResponse(typeof response === 'string' ? response : String(response ?? ''));

    const isAppropriate = raw.isAppropriate === true;
    const concerns = Array.isArray(raw.concerns)
      ? (raw.concerns as string[])
      : [];
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : '';
    const acceptableChanges = raw.acceptableChanges && typeof raw.acceptableChanges === 'object'
      ? raw.acceptableChanges as Record<string, unknown>
      : undefined;

    logger.info(`Safety eval: appropriate=${String(isAppropriate)}, concerns=${String(concerns.length)}, hasAcceptable=${String(!!acceptableChanges)}`);

    return { isAppropriate, concerns, reasoning, acceptableChanges };
  } catch (error) {
logger.error({ msg: 'Failed to evaluate modification safety', err: error });
    // Default to safe behavior - reject the modification if we can't evaluate it
    return {
      isAppropriate: false,
      concerns: ['Safety evaluation failed'],
      reasoning: 'Unable to evaluate modification safety, rejecting for security',
    };
  }
}

/**
 * Check if user has admin permissions for character modifications
 */
async function checkAdminPermissions(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
  const userId = message.entityId;
const adminUsersRaw = runtime.getSetting('ADMIN_USERS');
  const adminUsers = (typeof adminUsersRaw === 'string' ? adminUsersRaw : '').split(',').filter(Boolean);
  const nodeEnv = runtime.getSetting('NODE_ENV') || process.env.NODE_ENV;

  // In development/test mode, be more permissive for testing
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    logger.debug({
      msg: 'Development mode: allowing modification request',
      userId,
      nodeEnv,
    });
    return true;
  }

  // In production, check explicit admin list
  const isAdmin = adminUsers.includes(userId);

logger.info({
    msg: 'Admin permission check',
    userId,
    isAdmin,
    adminUsersConfigured: adminUsers.length > 0,
    nodeEnv,
  });

  // If no admin users configured, reject for security
  if (adminUsers.length === 0) {
    logger.warn('No admin users configured - rejecting modification request for security');
    return false;
  }

  return isAdmin;
}

/**
 * Create a human-readable summary of the modification
 */
function summarizeModification(modification: Record<string, unknown>): string {
  const parts: string[] = [];

  if (typeof modification.name === 'string') {
    parts.push(`Changed name to "${modification.name}"`);
  }

  if (typeof modification.system === 'string') {
    parts.push(`Updated system prompt (${modification.system.length} characters)`);
  }

  const bio = modification.bio as string[] | undefined;
  if (bio && bio.length > 0) {
    parts.push(`Added ${bio.length} new bio element(s)`);
  }

  const topics = modification.topics as string[] | undefined;
  if (topics && topics.length > 0) {
    parts.push(`Added topics: ${topics.join(', ')}`);
  }

  if (modification.style && typeof modification.style === 'object') {
    const styleChanges = Object.keys(modification.style).length;
    parts.push(`Updated ${styleChanges} style preference(s)`);
  }

  const messageExamples = modification.messageExamples as unknown[] | undefined;
  if (messageExamples && messageExamples.length > 0) {
    parts.push(`Added ${messageExamples.length} new response example(s)`);
  }

  return parts.length > 0 ? parts.join('; ') : 'Applied character updates';
}
