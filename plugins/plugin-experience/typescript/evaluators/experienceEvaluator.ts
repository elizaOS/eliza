import {
  type ActionResult,
  composePrompt,
  type Evaluator,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import { EXTRACT_EXPERIENCES_TEMPLATE } from "../generated/prompts/typescript/prompts.js";
import type { ExperienceService } from "../service";
import { ExperienceType, OutcomeType } from "../types";

type ExtractedExperience = {
  type?: string;
  learning?: string;
  context?: string;
  confidence?: number;
  reasoning?: string;
};

export const experienceEvaluator: Evaluator = {
  name: "EXPERIENCE_EVALUATOR",
  similes: ["experience recorder", "learning evaluator", "self-reflection"],
  description: "Periodically analyzes conversation patterns to extract novel learning experiences",
  alwaysRun: false,

  examples: [
    {
      prompt: "The agent successfully executed a shell command after initially failing",
      messages: [
        {
          name: "Autoliza",
          content: {
            text: "Let me try to run this Python script.",
          },
        },
        {
          name: "Autoliza",
          content: {
            text: "Error: ModuleNotFoundError for pandas. I need to install it first.",
          },
        },
        {
          name: "Autoliza",
          content: {
            text: "After installing pandas, the script ran successfully and produced the expected output.",
          },
        },
      ],
      outcome:
        "Record a CORRECTION experience about needing to install dependencies before running Python scripts",
    },
    {
      prompt: "The agent discovered a new system capability",
      messages: [
        {
          name: "Autoliza",
          content: {
            text: "I found that the system has jq installed, which is perfect for parsing JSON data.",
          },
        },
      ],
      outcome: "Record a DISCOVERY experience about the availability of jq for JSON processing",
    },
  ],

  async validate(runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> {
    // Only run every 10 messages and only on agent messages
    if (message.entityId !== runtime.agentId) {
      return false;
    }

    // Check cooldown - only extract experiences every 10 messages
    const lastExtractionKey = "experience-extraction:last-message-count";
    const currentCount = (await runtime.getCache<string>(lastExtractionKey)) || "0";
    const messageCount = Number.parseInt(currentCount, 10);
    const newMessageCount = messageCount + 1;

    await runtime.setCache(lastExtractionKey, newMessageCount.toString());

    // Trigger extraction every 10 messages
    const shouldExtract = newMessageCount % 10 === 0;

    if (shouldExtract) {
      logger.info(
        `[experienceEvaluator] Triggering experience extraction after ${newMessageCount} messages`
      );
    }

    return shouldExtract;
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    _callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult | undefined> {
    void _options;
    void _callback;
    void _responses;
    void state;

    const experienceService = runtime.getService("EXPERIENCE") as ExperienceService | null;

    if (!experienceService) {
      logger.warn("[experienceEvaluator] Experience service not available");
      return;
    }

    const recentMessages = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      count: 10,
      unique: false,
    });

    if (recentMessages.length < 3) {
      logger.debug("[experienceEvaluator] Not enough messages for experience extraction");
      return;
    }

    // Combine recent messages into analysis context
    const conversationContext = recentMessages
      .map((m: Memory) => m.content.text)
      .filter(Boolean)
      .join(" ");

    // Query existing experiences for similarity check
    const existingExperiences = await experienceService.queryExperiences({
      query: conversationContext,
      limit: 10,
      minConfidence: 0.7,
    });

    const existingExperiencesText =
      existingExperiences.length > 0
        ? existingExperiences.map((exp) => `- ${exp.learning}`).join("\n")
        : "None";

    const extractionPrompt = composePrompt({
      state: {
        conversation_context: conversationContext,
        existing_experiences: existingExperiencesText,
      },
      template: EXTRACT_EXPERIENCES_TEMPLATE,
    });

    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: extractionPrompt,
    });

    const experiences = parseExtractedExperiences(response);

    const threshold = getNumberSetting(runtime, "AUTO_RECORD_THRESHOLD", 0.6);

    // Record each novel experience
    const experienceTypeMap: Record<string, ExperienceType> = {
      DISCOVERY: ExperienceType.DISCOVERY,
      CORRECTION: ExperienceType.CORRECTION,
      SUCCESS: ExperienceType.SUCCESS,
      LEARNING: ExperienceType.LEARNING,
    };

    for (const exp of experiences.slice(0, 3)) {
      // Max 3 experiences per extraction
      if (!exp.learning || typeof exp.confidence !== "number" || exp.confidence < threshold) {
        continue;
      }

      const normalizedType = typeof exp.type === "string" ? exp.type.toUpperCase() : "";
      const experienceType = experienceTypeMap[normalizedType] ?? ExperienceType.LEARNING;
      const experienceTag = experienceType;

      await experienceService.recordExperience({
        type: experienceType,
        outcome:
          experienceType === ExperienceType.CORRECTION ? OutcomeType.POSITIVE : OutcomeType.NEUTRAL,
        context: sanitizeContext(exp.context || "Conversation analysis"),
        action: "pattern_recognition",
        result: exp.learning,
        learning: sanitizeContext(exp.learning),
        domain: detectDomain(exp.learning),
        tags: ["extracted", "novel", experienceTag],
        confidence: Math.min(exp.confidence, 0.9), // Cap confidence
        importance: 0.8, // High importance for extracted experiences
      });

      logger.info(
        `[experienceEvaluator] Recorded novel experience: ${exp.learning.substring(0, 100)}...`
      );
    }

    if (experiences.length > 0) {
      logger.info(
        `[experienceEvaluator] Extracted ${experiences.length} novel experiences from conversation`
      );
    } else {
      logger.debug("[experienceEvaluator] No novel experiences found in recent conversation");
    }

    return {
      success: true,
      data: {
        extractedCount: experiences.length,
      },
      values: {
        extractedCount: experiences.length.toString(),
      },
    };
  },
};

function parseExtractedExperiences(response: string): ExtractedExperience[] {
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as ExtractedExperience[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === "object");
  } catch {
    return [];
  }
}

function getNumberSetting(runtime: IAgentRuntime, key: string, fallback: number): number {
  const value = runtime.getSetting(key);
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function sanitizeContext(text: string): string {
  if (!text) return "Unknown context";

  // Remove user-specific details while preserving technical context
  return text
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[EMAIL]") // emails
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[IP]") // IP addresses
    .replace(/\/Users\/[^/\s]+/g, "/Users/[USER]") // user directories
    .replace(/\/home\/[^/\s]+/g, "/home/[USER]") // home directories
    .replace(/\b[A-Z0-9]{20,}\b/g, "[TOKEN]") // API keys/tokens
    .replace(/\b(user|person|someone|they)\s+(said|asked|told|mentioned)/gi, "when asked") // personal references
    .substring(0, 200); // limit length
}

function detectDomain(text: string): string {
  const domains: Record<string, string[]> = {
    shell: ["command", "terminal", "bash", "shell", "execute", "script", "cli"],
    coding: [
      "code",
      "function",
      "variable",
      "syntax",
      "programming",
      "debug",
      "typescript",
      "javascript",
    ],
    system: ["file", "directory", "process", "memory", "cpu", "system", "install", "package"],
    network: ["http", "api", "request", "response", "url", "network", "fetch", "curl"],
    data: ["json", "csv", "database", "query", "data", "sql", "table"],
    ai: ["model", "llm", "embedding", "prompt", "token", "inference"],
  };

  const lowerText = text.toLowerCase();

  for (const [domain, keywords] of Object.entries(domains)) {
    if (keywords.some((keyword) => lowerText.includes(keyword))) {
      return domain;
    }
  }

  return "general";
}
