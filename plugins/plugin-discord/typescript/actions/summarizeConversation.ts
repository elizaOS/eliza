import fs from "node:fs";
import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  ContentType,
  composePromptFromState,
  getEntityDetails,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Media,
  type Memory,
  MemoryType,
  ModelType,
  parseJSONObjectFromText,
  type State,
  splitChunks,
  trimTokens,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/spec-helpers";

/**
 * Normalizes a numeric timestamp to milliseconds.
 * Detects whether the input is likely in seconds or milliseconds based on magnitude.
 *
 * Heuristic: Unix timestamps in seconds are ~10 digits (e.g., 1703001600 for 2023)
 * Unix timestamps in milliseconds are ~13 digits (e.g., 1703001600000 for 2023)
 * We use a threshold: if the number represents a date before year 2000 when interpreted
 * as milliseconds, it's likely in seconds and needs conversion.
 *
 * @param {number} timestamp - The numeric timestamp to normalize
 * @returns {number} Timestamp in milliseconds
 */
function normalizeTimestamp(timestamp: number): number {
  // Threshold: Jan 1, 2000 in milliseconds = 946684800000
  // If timestamp is less than this, it's likely in seconds (or an invalid/ancient date)
  // A Unix timestamp in seconds for year 2000+ would be > 946684800 (~10 digits)
  // which when treated as ms would be < Jan 12, 1970
  const year2000InMs = 946684800000;

  if (timestamp > 0 && timestamp < year2000InMs) {
    // Likely in seconds - convert to milliseconds
    // Additional sanity check: result should be a reasonable date (after 2000, before 2100)
    const asMs = timestamp * 1000;
    const year2100InMs = 4102444800000;
    if (asMs >= year2000InMs && asMs <= year2100InMs) {
      return asMs;
    }
  }

  return timestamp;
}

/**
 * Parses various time formats into a Unix timestamp (milliseconds).
 * Supports:
 * - Absolute timestamps (number or numeric string): 1234567890000 or 1234567890 (auto-detects seconds vs ms)
 * - Relative time strings: "5 minutes ago", "2 hours ago", "3 days ago"
 * - ISO date strings: "2024-01-15T10:30:00Z"
 *
 * Month and year calculations use approximate values (30/365 days) to ensure inclusive time ranges.
 *
 * @param {string | number} input - The time value to parse
 * @returns {number} Unix timestamp in milliseconds
 */
function parseTimeToTimestamp(input: string | number): number {
  // If already a number, normalize and return
  if (typeof input === "number") {
    return normalizeTimestamp(input);
  }

  // Try parsing as a direct numeric string (timestamp)
  const asNumber = Number(input);
  if (!Number.isNaN(asNumber) && asNumber > 0) {
    return normalizeTimestamp(asNumber);
  }

  // Try parsing as ISO date
  const isoDate = Date.parse(input);
  if (!Number.isNaN(isoDate)) {
    return isoDate;
  }

  // Parse relative time format: "<number> <unit> ago", e.g. "5 minutes ago", "2 hours ago"
  const relativeMatch = input.match(
    /(\d+\.?\d*)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i
  );
  if (relativeMatch) {
    const value = parseFloat(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();

    // Approximate multipliers for time units
    // Month = 30 days, Year = 365 days (no leap year handling)
    // This provides consistent, inclusive time ranges for conversation retrieval
    const multipliers: Record<string, number> = {
      second: 1000,
      minute: 60 * 1000,
      hour: 3600 * 1000,
      day: 86400 * 1000,
      week: 7 * 86400 * 1000,
      month: 30 * 86400 * 1000, // Approximation: actual months vary 28-31 days
      year: 365 * 86400 * 1000, // Approximation: ignores leap years
    };

    const milliseconds = value * (multipliers[unit] || 0);

    // "<number> <unit> ago" means subtract from now
    return Date.now() - milliseconds;
  }

  // Fallback: return current time if we can't parse
  // Log warning for malformed model output
  logger.warn(`[parseTimeToTimestamp] Could not parse time value, using current time: ${input}`);
  return Date.now();
}

// Import generated prompts
import {
  dateRangeTemplate,
  summarizationTemplate,
} from "../generated/prompts/typescript/prompts.js";

/**
 * Function to get a date range from user input.
 *
 * @param {IAgentRuntime} runtime - The Agent Runtime object.
 * @param {Memory} _message - The Memory object.
 * @param {State} state - The State object.
 * @return {Promise<{ objective: string; start: number; end: number; } | null>} Parsed user input containing objective, start, and end timestamps, or null.
 */
const getDateRange = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
): Promise<{ objective: string; start: number; end: number } | null> => {
  const prompt = composePromptFromState({
    state,
    template: dateRangeTemplate,
  });

  for (let i = 0; i < 5; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    // try parsing to a json object
    const parsedResponse = parseJSONObjectFromText(response) as {
      objective: string;
      start: string | number;
      end: string | number;
    } | null;
    // see if it contains objective, start and end
    if (parsedResponse) {
      if (parsedResponse.objective && parsedResponse.start && parsedResponse.end) {
        // Parse start and end into proper timestamps (returns numbers)
        const startRaw = parseTimeToTimestamp(parsedResponse.start);
        const endRaw = parseTimeToTimestamp(parsedResponse.end);

        // Validate that both timestamps are finite numbers
        if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) {
          logger.warn(
            `[getDateRange] Invalid timestamps parsed: start=${startRaw}, end=${endRaw}, retrying...`
          );
          continue;
        }

        // Normalize: ensure start <= end (swap if model returned them inverted)
        let start = startRaw <= endRaw ? startRaw : endRaw;
        const end = startRaw <= endRaw ? endRaw : startRaw;

        // If start === end, widen the window by 1 hour to avoid empty queries
        if (start === end) {
          start = end - 3600 * 1000; // 1 hour before end
        }

        return {
          objective: parsedResponse.objective,
          start,
          end,
        };
      }
    }
  }
  return null;
};

/**
 * Action to summarize a conversation and attachments.
 *
 * @typedef {Action} summarizeAction
 * @property {string} name - The name of the action.
 * @property {string[]} similes - Array of related terms.
 * @property {string} description - Description of the action.
 * @property {Function} validate - Asynchronous function to validate the action.
 * @property {Function} handler - Asynchronous function to handle the action.
 * @property {ActionExample[][]} examples - Array of examples demonstrating the action.
 */
const spec = requireActionSpec("SUMMARIZE_CONVERSATION");

export const summarize: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (message.content.source !== "discord") {
      return false;
    }
    // only show if one of the keywords are in the message
    const keywords: string[] = [
      "summarize",
      "summarization",
      "summary",
      "recap",
      "report",
      "overview",
      "review",
      "rundown",
      "wrap-up",
      "brief",
      "debrief",
      "abstract",
      "synopsis",
      "outline",
      "digest",
      "abridgment",
      "condensation",
      "encapsulation",
      "essence",
      "gist",
      "main points",
      "key points",
      "key takeaways",
      "bulletpoint",
      "highlights",
      "tldr",
      "tl;dr",
      "in a nutshell",
      "bottom line",
      "long story short",
      "sum up",
      "sum it up",
      "short version",
      "bring me up to speed",
      "catch me up",
    ];
    return keywords.some((keyword) =>
      message.content.text?.toLowerCase().includes(keyword.toLowerCase())
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    if (!state) {
      if (callback) {
        await callback?.({
          text: "State is not available.",
          source: "discord",
        });
      }
      return { success: false, error: "State is not available" };
    }

    const callbackData: Content = {
      text: "", // fill in later
      actions: ["SUMMARIZATION_RESPONSE"],
      source: message.content.source,
      attachments: [],
    };
    const { roomId } = message;

    // 1. extract date range from the message
    const dateRange = await getDateRange(runtime, message, state);
    if (!dateRange) {
      runtime.logger.warn(
        {
          src: "plugin:discord:action:summarize-conversation",
          agentId: runtime.agentId,
        },
        "Could not get date range from message"
      );
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: "discord",
            thought: "I couldn't get the date range from the message",
            actions: ["SUMMARIZE_CONVERSATION_FAILED"],
          },
          metadata: {
            type: MemoryType.CUSTOM,
          },
        },
        "messages"
      );
      return { success: false, error: "Could not get date range from message" };
    }

    const { objective, start, end } = dateRange;

    // 2. get these memories from the database (start/end are absolute ms timestamps)
    const memories = await runtime.getMemories({
      tableName: "messages",
      roomId,
      start,
      end,
      count: 10000,
      unique: false,
    });

    const entities = await getEntityDetails({
      runtime: runtime as IAgentRuntime,
      roomId,
    });

    const actorMap = new Map(entities.map((entity) => [entity.id, entity]));

    const formattedMemories = memories
      .map((memory) => {
        const memoryAttachments = memory.content.attachments;
        const attachments =
          memoryAttachments
            ?.map((attachment: Media) => {
              return `---\nAttachment: ${attachment.id}\n${attachment.description}\n${attachment.text}\n---`;
            })
            .join("\n") || "";
        const entity = actorMap.get(memory.entityId);
        const entityName = entity?.name ?? "Unknown User";
        const entityUsername = entity?.username ?? "";
        return `${entityName} (${entityUsername}): ${memory.content.text}\n${attachments}`;
      })
      .join("\n");

    let currentSummary = "";

    const chunkSize = 8000;

    const chunks = await splitChunks(formattedMemories, chunkSize, 0);

    //const _datestr = new Date().toUTCString().replace(/:/g, "-");

    state.values.memoriesWithAttachments = formattedMemories;
    state.values.objective = objective;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      state.values.currentSummary = currentSummary;
      state.values.currentChunk = chunk;
      const template = await trimTokens(summarizationTemplate, chunkSize + 500, runtime);
      const prompt = composePromptFromState({
        state,
        // make sure it fits, we can pad the tokens a bit
        template,
      });

      const summary = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      currentSummary = `${currentSummary}\n${summary}`;
    }

    if (!currentSummary) {
      runtime.logger.warn(
        {
          src: "plugin:discord:action:summarize-conversation",
          agentId: runtime.agentId,
        },
        "No summary found"
      );
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: "discord",
            thought: "I couldn't summarize the conversation",
            actions: ["SUMMARIZE_CONVERSATION_FAILED"],
          },
          metadata: {
            type: MemoryType.CUSTOM,
          },
        },
        "messages"
      );
      return { success: false, error: "Could not summarize conversation" };
    }

    callbackData.text = currentSummary.trim();
    const trimmedSummary = currentSummary.trim();
    if (
      callbackData.text &&
      ((trimmedSummary && trimmedSummary.split("\n").length < 4) ||
        (trimmedSummary && trimmedSummary.split(" ").length < 100))
    ) {
      callbackData.text = `Here is the summary:
\`\`\`md
${currentSummary.trim()}
\`\`\`
`;
      if (callback) {
        await callback?.(callbackData);
      }
      return { success: true, text: callbackData.text };
    } else if (currentSummary.trim()) {
      const summaryDir = "cache";
      const summaryFilename = `${summaryDir}/conversation_summary_${Date.now()}`;
      await runtime.setCache<string>(summaryFilename, currentSummary);
      await fs.promises.mkdir(summaryDir, { recursive: true });

      await fs.promises.writeFile(summaryFilename, currentSummary, "utf8");
      // save the summary to a file
      if (callback) {
        await callback?.({
          ...callbackData,
          text: `I've attached the summary of the conversation from \`${new Date(start).toString()}\` to \`${new Date(end).toString()}\` as a text file.`,
          attachments: [
            ...(callbackData.attachments || []),
            {
              id: summaryFilename,
              url: summaryFilename,
              title: "Conversation Summary",
              source: "discord",
              contentType: ContentType.DOCUMENT,
            } as Media,
          ],
        });
      }
      return { success: true, text: `Summary saved to ${summaryFilename}` };
    } else {
      runtime.logger.warn(
        {
          src: "plugin:discord:action:summarize-conversation",
          agentId: runtime.agentId,
        },
        "Empty response from summarize conversation action"
      );
      return { success: false, error: "Empty response from summarize conversation action" };
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default summarize;
