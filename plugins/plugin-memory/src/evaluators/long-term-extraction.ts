import {
  type IAgentRuntime,
  type Memory,
  type Evaluator,
  logger,
  ModelType,
  composePromptFromState,
} from "@elizaos/core";
import { MemoryService } from "../services/memory-service";
import { LongTermMemoryCategory, type MemoryExtraction } from "../types/index";

/**
 * Template for extracting long-term memories using cognitive science memory types
 */
const extractionTemplate = `# Task: Extract Long-Term Memory (Strict Criteria)

You are analyzing a conversation to extract ONLY the most critical, persistent information about the user using cognitive science memory categories.

# Recent Messages
{{recentMessages}}

# Current Long-Term Memories
{{existingMemories}}

# Memory Categories (Based on Cognitive Science)

## 1. EPISODIC Memory
Personal experiences and specific events with temporal/spatial context.
**Examples:**
- "User completed migration project from MongoDB to PostgreSQL in Q2 2024"
- "User encountered authentication bug in production on March 15th"
- "User had a negative experience with Docker networking in previous job"

**Requirements:**
- Must include WHO did WHAT, WHEN/WHERE
- Must be a specific, concrete event (not a pattern)
- Must have significant impact or relevance to future work

## 2. SEMANTIC Memory
General facts, concepts, knowledge, and established truths about the user.
**Examples:**
- "User is a senior backend engineer with 8 years experience"
- "User specializes in distributed systems and microservices architecture"
- "User's primary programming language is TypeScript"
- "User works at Acme Corp as technical lead"

**Requirements:**
- Must be factual, timeless information
- Must be explicitly stated or demonstrated conclusively
- No speculation or inference from single instances
- Core identity, expertise, or knowledge only

## 3. PROCEDURAL Memory
Skills, workflows, methodologies, and how-to knowledge.
**Examples:**
- "User follows strict TDD workflow: write tests first, then implementation"
- "User prefers git rebase over merge to maintain linear history"
- "User's debugging process: check logs → reproduce locally → binary search"
- "User always writes JSDoc comments before implementing functions"

**Requirements:**
- Must describe HOW user does something
- Must be a repeated, consistent pattern (seen 3+ times or explicitly stated as standard practice)
- Must be a workflow, methodology, or skill application
- Not one-off preferences

# ULTRA-STRICT EXTRACTION CRITERIA

## ✅ DO EXTRACT (Only These):

**EPISODIC:**
- Significant completed projects or milestones
- Important bugs, incidents, or problems encountered
- Major decisions made with lasting impact
- Formative experiences that shape future work

**SEMANTIC:**
- Professional identity (role, title, company)
- Core expertise and specializations (stated explicitly or demonstrated conclusively)
- Primary languages, frameworks, or tools (not exploratory use)
- Established facts about their work context

**PROCEDURAL:**
- Consistent workflows demonstrated 3+ times or explicitly stated
- Standard practices user always follows
- Methodology preferences with clear rationale
- Debugging, testing, or development processes

## ❌ NEVER EXTRACT:

- **One-time requests or tasks** (e.g., "can you generate an image", "help me debug this")
- **Casual conversations** without lasting significance
- **Exploratory questions** (e.g., "how does X work?")
- **Temporary context** (current bug, today's task)
- **Preferences from single occurrence** (e.g., user asked for code once)
- **Social pleasantries** (thank you, greetings)
- **Testing or experimentation** (trying out a feature)
- **Common patterns everyone has** (likes clear explanations)
- **Situational information** (working on feature X today)
- **Opinions without persistence** (single complaint, isolated praise)
- **General knowledge** (not specific to user)

# Quality Gates (ALL Must Pass)

1. **Significance Test**: Will this matter in 3+ months?
2. **Specificity Test**: Is this concrete and actionable?
3. **Evidence Test**: Is there strong evidence (3+ instances OR explicit self-identification)?
4. **Uniqueness Test**: Is this specific to THIS user (not generic)?
5. **Confidence Test**: Confidence must be >= 0.85 (be VERY conservative)
6. **Non-Redundancy Test**: Does this add NEW information not in existing memories?

# Confidence Scoring (Be Conservative)

- **0.95-1.0**: User explicitly stated as core identity/practice AND demonstrated multiple times
- **0.85-0.94**: User explicitly stated OR consistently demonstrated 5+ times
- **0.75-0.84**: Strong pattern (3-4 instances) with supporting context
- **Below 0.75**: DO NOT EXTRACT (insufficient evidence)

# Critical Instructions

1. **Default to NOT extracting** - When in doubt, skip it
2. **Require overwhelming evidence** - One or two mentions is NOT enough
3. **Focus on what's PERSISTENT** - Not what's temporary or situational
4. **Verify against existing memories** - Don't duplicate or contradict
5. **Maximum 2-3 extractions per run** - Quality over quantity

**If there are no qualifying facts (which is common), respond with <memories></memories>**

# Response Format

<memories>
  <memory>
    <category>semantic</category>
    <content>User is a senior TypeScript developer with 8 years of backend experience</content>
    <confidence>0.95</confidence>
  </memory>
  <memory>
    <category>procedural</category>
    <content>User follows TDD workflow: writes tests before implementation, runs tests after each change</content>
    <confidence>0.88</confidence>
  </memory>
  <memory>
    <category>episodic</category>
    <content>User led database migration from MongoDB to PostgreSQL for payment system in Q2 2024</content>
    <confidence>0.92</confidence>
  </memory>
</memories>`;

/**
 * Parse XML memory extraction response
 */
function parseMemoryExtractionXML(xml: string): MemoryExtraction[] {
  const memoryMatches = xml.matchAll(
    /<memory>[\s\S]*?<category>(.*?)<\/category>[\s\S]*?<content>(.*?)<\/content>[\s\S]*?<confidence>(.*?)<\/confidence>[\s\S]*?<\/memory>/g
  );

  const extractions: MemoryExtraction[] = [];

  for (const match of memoryMatches) {
    const category = match[1].trim() as LongTermMemoryCategory;
    const content = match[2].trim();
    const confidence = parseFloat(match[3].trim());

    // Validate category
    if (!Object.values(LongTermMemoryCategory).includes(category)) {
      logger.warn(`Invalid memory category: ${category}`);
      continue;
    }

    if (content && !isNaN(confidence)) {
      extractions.push({ category, content, confidence });
    }
  }

  return extractions;
}

/**
 * Long-term Memory Extraction Evaluator
 *
 * Analyzes conversations to extract persistent facts about users that should be remembered
 * across all future conversations.
 */
export const longTermExtractionEvaluator: Evaluator = {
  name: "LONG_TERM_MEMORY_EXTRACTION",
  description: "Extracts long-term facts about users from conversations",
  similes: ["MEMORY_EXTRACTION", "FACT_LEARNING", "USER_PROFILING"],
  alwaysRun: true,

  validate: async (
    runtime: IAgentRuntime,
    message: Memory
  ): Promise<boolean> => {
    // Only run on user messages (not agent's own)
    if (message.entityId === runtime.agentId) {
      return false;
    }

    if (!message.content?.text) {
      return false;
    }

    const memoryService = runtime.getService("memory") as MemoryService | null;
    if (!memoryService) {
      return false;
    }

    const config = memoryService.getConfig();
    if (!config.longTermExtractionEnabled) {
      logger.debug("Long-term memory extraction is disabled");
      return false;
    }

    // Count total messages from this entity in this room
    const currentMessageCount = await runtime.countMemories(
      message.roomId,
      false,
      "messages"
    );

    const shouldRun = await memoryService.shouldRunExtraction(
      message.entityId,
      message.roomId,
      currentMessageCount
    );
    return shouldRun;
  },

  handler: async (runtime: IAgentRuntime, message: Memory): Promise<void> => {
    const memoryService = runtime.getService("memory") as MemoryService;
    if (!memoryService) {
      logger.error("MemoryService not found");
      return;
    }

    const config = memoryService.getConfig();
    const { entityId, roomId } = message;

    try {
      logger.info(`Extracting long-term memories for entity ${entityId}`);

      // Get recent conversation context
      const recentMessages = await runtime.getMemories({
        tableName: "messages",
        roomId,
        count: 20,
        unique: false,
      });

      const formattedMessages = recentMessages
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map((msg) => {
          const sender =
            msg.entityId === runtime.agentId ? runtime.character.name : "User";
          return `${sender}: ${msg.content.text || "[non-text message]"}`;
        })
        .join("\n");

      // Get existing long-term memories
      const existingMemories = await memoryService.getLongTermMemories(
        entityId,
        undefined,
        30
      );
      const formattedExisting =
        existingMemories.length > 0
          ? existingMemories
              .map(
                (m) =>
                  `[${m.category}] ${m.content} (confidence: ${m.confidence})`
              )
              .join("\n")
          : "None yet";

      // Generate extraction using LLM
      const state = await runtime.composeState(message);
      const prompt = composePromptFromState({
        state: {
          ...state,
          recentMessages: formattedMessages,
          existingMemories: formattedExisting,
        },
        template: extractionTemplate,
      });

      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      const extractions = parseMemoryExtractionXML(response);

      logger.info(`Extracted ${extractions.length} long-term memories`);

      // Store each extracted memory
      for (const extraction of extractions) {
        // Apply stricter confidence threshold (0.85 minimum)
        if (
          extraction.confidence >=
          Math.max(config.longTermConfidenceThreshold, 0.85)
        ) {
          await memoryService.storeLongTermMemory({
            agentId: runtime.agentId,
            entityId,
            category: extraction.category,
            content: extraction.content,
            confidence: extraction.confidence,
            source: "conversation",
            metadata: {
              roomId,
              extractedAt: new Date().toISOString(),
            },
          });

          logger.info(
            `Stored long-term memory: [${
              extraction.category
            }] ${extraction.content.substring(0, 50)}...`
          );
        } else {
          logger.debug(
            `Skipped low-confidence memory: ${
              extraction.content
            } (confidence: ${extraction.confidence}, threshold: ${Math.max(
              config.longTermConfidenceThreshold,
              0.85
            )})`
          );
        }
      }

      // Update the extraction checkpoint after successful extraction
      const currentMessageCount = await runtime.countMemories(
        roomId,
        false,
        "messages"
      );
      await memoryService.setLastExtractionCheckpoint(
        entityId,
        roomId,
        currentMessageCount
      );
      logger.debug(
        `Updated extraction checkpoint to ${currentMessageCount} for entity ${entityId} in room ${roomId}`
      );
    } catch (error) {
      logger.error({ error }, "Error during long-term memory extraction:");
    }
  },

  examples: [],
};
