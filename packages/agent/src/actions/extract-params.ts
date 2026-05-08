/**
 * Self-correcting LLM-based parameter extraction for action handlers.
 *
 * Project policy:
 *   - The action planner is the *primary* extractor of params.
 *   - Handlers MUST NOT use regex / string matching for intent inference.
 *   - But planners get params wrong frequently — small models drop fields,
 *     misname keys, send strings as numbers, etc.
 *   - When that happens, the action handler runs its OWN small LLM call
 *     scoped to the conversation + action's parameter schema. The handler
 *     never falls back to regex; it falls back to the LLM.
 *
 * This module provides one helper, `extractActionParamsViaLlm`, which any
 * action handler can call when its incoming `params` are missing required
 * fields. The handler prefers planner-supplied values (planner is
 * authoritative); the helper only fills in missing slots.
 *
 * Usage in a handler:
 *
 *   const filled = await extractActionParamsViaLlm<MyParams>({
 *     runtime, message, state,
 *     actionName: "MESSAGE",
 *     actionDescription: "Cross-channel inbox: triage / digest / respond / search...",
 *     paramSchema: triageMessagesAction.parameters,
 *     existingParams: planParams,
 *     requiredFields: ["subaction"],
 *   });
 *   if (!filled.subaction) {
 *     return cleanError("MISSING_SUBACTION");
 *   }
 *
 * The helper:
 *   - Inspects which required fields are missing from `existingParams`
 *   - If none are missing, returns existingParams unchanged (no model call)
 *   - Otherwise builds a focused JSON-extraction prompt with the action's
 *     name, description, schema, the recent conversation, and the current
 *     message
 *   - Calls `runtime.useModel(ModelType.TEXT_SMALL)` and parses the JSON
 *   - Merges extracted values UNDER existing planner values (planner wins
 *     on every field)
 *   - Returns silently with whatever was extractable; handler decides what
 *     to do if the result is still incomplete.
 */

import {
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { getRecentMessagesData } from "@elizaos/shared";

/**
 * Schema descriptor for a single action parameter — matches the shape used
 * by Action.parameters, with the fields the extractor needs.
 */
export interface ParamSchemaDescriptor {
  name: string;
  description: string;
  required?: boolean;
  schema?: { type?: string; enum?: readonly string[] | string[] };
}

export interface ExtractActionParamsArgs<
  T extends object = Record<string, unknown>,
> {
  runtime: IAgentRuntime;
  message: Memory;
  state?: State;
  /** Canonical action name (used in the prompt + log lines). */
  actionName: string;
  /** Plain-English description of what the action does. */
  actionDescription: string;
  /** Action.parameters schema (or a subset of it). */
  paramSchema: readonly ParamSchemaDescriptor[];
  /** Whatever the planner already supplied. */
  existingParams: Partial<T>;
  /**
   * Names of fields the handler needs to proceed. If all of these are
   * already present and non-null in existingParams, the helper short-
   * circuits without calling the model.
   */
  requiredFields: ReadonlyArray<keyof T & string>;
  /** Override the model tier (default: TEXT_SMALL). */
  modelType?: (typeof ModelType)[keyof typeof ModelType];
  /** Override how many recent messages to feed into the prompt (default 8). */
  recentMessagesLimit?: number;
}

const DEFAULT_RECENT_MESSAGES_LIMIT = 8;

/**
 * Run a small LLM extraction call to fill in missing required params from
 * the conversation. Planner-supplied values always win; the helper only
 * fills slots that are still missing.
 */
export async function extractActionParamsViaLlm<
  T extends object = Record<string, unknown>,
>(args: ExtractActionParamsArgs<T>): Promise<Partial<T>> {
  const {
    runtime,
    message,
    state,
    actionName,
    actionDescription,
    paramSchema,
    existingParams,
    requiredFields,
    modelType = ModelType.TEXT_SMALL,
    recentMessagesLimit = DEFAULT_RECENT_MESSAGES_LIMIT,
  } = args;

  const missing = requiredFields.filter((field) => {
    const value = (existingParams as Record<string, unknown>)[field];
    return value === undefined || value === null || value === "";
  });
  if (missing.length === 0) {
    return existingParams;
  }

  const currentMessageText =
    typeof message.content?.text === "string"
      ? message.content.text.trim()
      : "";
  const recentConversation = collectRecentConversation(
    state,
    recentMessagesLimit,
  );

  const prompt = buildExtractionPrompt({
    actionName,
    actionDescription,
    paramSchema,
    existingParams,
    missingFields: missing,
    currentMessageText,
    recentConversation,
  });

  let response: string;
  try {
    const raw = await runtime.useModel(modelType, {
      prompt,
      stopSequences: [],
    });
    response = typeof raw === "string" ? raw : String(raw ?? "");
  } catch (err) {
    logger.warn(
      `[${actionName}] LLM param extraction failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return existingParams;
  }

  const extracted = parseExtraction(response);
  if (!extracted) {
    return existingParams;
  }

  // Merge: extracted fills in missing slots only. Planner values always win
  // on collisions because the planner saw the full action surface.
  const merged: Record<string, unknown> = { ...extracted };
  for (const [key, value] of Object.entries(existingParams)) {
    if (value !== undefined && value !== null && value !== "") {
      merged[key] = value;
    }
  }
  return merged as Partial<T>;
}

function collectRecentConversation(
  state: State | undefined,
  limit: number,
): string {
  if (!state) return "";
  const messages = getRecentMessagesData(state).slice(-limit);
  if (messages.length === 0) return "";
  return messages
    .map((m) => {
      const content =
        m.content && typeof m.content === "object"
          ? (m.content as Record<string, unknown>)
          : null;
      const text = typeof content?.text === "string" ? content.text.trim() : "";
      const speaker = getMemorySpeakerName(m);
      return text ? `${speaker}: ${text}` : null;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

function getMemorySpeakerName(memory: Memory): string {
  const metadata = memory.metadata;
  if (!metadata) return "user";

  if (
    "sender" in metadata &&
    metadata.sender &&
    typeof metadata.sender === "object" &&
    "name" in metadata.sender &&
    typeof metadata.sender.name === "string"
  ) {
    return metadata.sender.name;
  }

  if ("entityName" in metadata && typeof metadata.entityName === "string") {
    return metadata.entityName;
  }

  if (
    "entityUserName" in metadata &&
    typeof metadata.entityUserName === "string"
  ) {
    return metadata.entityUserName;
  }

  return "user";
}

function buildExtractionPrompt(args: {
  actionName: string;
  actionDescription: string;
  paramSchema: readonly ParamSchemaDescriptor[];
  existingParams: Record<string, unknown>;
  missingFields: ReadonlyArray<string>;
  currentMessageText: string;
  recentConversation: string;
}): string {
  const {
    actionName,
    actionDescription,
    paramSchema,
    existingParams,
    missingFields,
    currentMessageText,
    recentConversation,
  } = args;

  const schemaLines = paramSchema
    .map((p) => {
      const enumPart = p.schema?.enum
        ? ` [one of: ${(p.schema.enum as readonly string[]).join(" | ")}]`
        : "";
      const typePart = p.schema?.type ? ` (${p.schema.type})` : "";
      const requiredPart = missingFields.includes(p.name) ? " [REQUIRED]" : "";
      return `  - ${p.name}${typePart}${enumPart}${requiredPart}: ${p.description}`;
    })
    .join("\n");

  const existingJson = JSON.stringify(existingParams ?? {}, null, 0);

  return [
    `You are filling in missing parameters for the ${actionName} action.`,
    `Action description: ${actionDescription}`,
    ``,
    `Parameter schema:`,
    schemaLines,
    ``,
    `Already-supplied parameters: ${existingJson}`,
    ``,
    `Missing required fields you must extract: ${missingFields.join(", ")}`,
    ``,
    recentConversation
      ? `Recent conversation (oldest first):\n${recentConversation}`
      : `(no recent conversation context)`,
    ``,
    `Current user message: ${currentMessageText || "(empty)"}`,
    ``,
    `Return ONLY a JSON object containing values for the MISSING fields.`,
    `If a value is genuinely indeterminable from the conversation, return null for that field.`,
    `Do not return any text outside the JSON. Do not wrap it in markdown.`,
    `Example: {"subaction": "search", "query": "github"}`,
  ].join("\n");
}

function parseExtraction(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed = parseJSONObjectFromText(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Drop null-valued fields so they don't overwrite planner-supplied
      // values during the merge step.
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null) out[k] = v;
      }
      return out;
    }
  } catch {
    // fall through
  }
  return null;
}
