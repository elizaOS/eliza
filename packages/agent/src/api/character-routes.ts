/**
 * HTTP routes for reading and editing the running agent's character. Mounts the
 * `/api/character` surface: GET the merged character, PUT edits (validated,
 * persisted to the agent row so they survive restart, mirrored into the config
 * file, and journaled to character history), GET `/history`, GET `/random-name`,
 * GET `/schema` (the editable-field descriptor the dashboard renders), and POST
 * `/generate` (LLM-authored bio/system/style/examples via TEXT_SMALL). Renaming
 * rewrites speaker names and `{{agentName}}`/`{{name}}` tokens in the message
 * examples so the persona stays self-consistent.
 */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type { RouteRequestContext } from "@elizaos/shared";
import { PostCharacterGenerateRequestSchema } from "@elizaos/shared";
import {
  buildCharacterHistorySnapshot,
  type CharacterHistorySnapshot,
  isCharacterHistoryUnbounded,
  listCharacterHistory,
  type RuntimeCharacterLike,
  readOwnDataValue,
  recordCharacterHistory,
} from "../services/character-history.ts";
import { invalidateConversationConnectionTopology } from "./conversation-connection-readiness.ts";

interface CharacterGenerateContext {
  name?: string;
  system?: string;
  bio?: string;
  topics?: string[];
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  postExamples?: string[];
}

type CharacterGenerateField =
  | "bio"
  | "system"
  | "style"
  | "chatExamples"
  | "postExamples";
type CharacterGenerateMode = "append" | "replace";

interface AgentConfigLike {
  id?: string;
  default?: boolean;
  name?: string;
  bio?: string[];
  system?: string;
  adjectives?: string[];
  topics?: string[];
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  messageExamples?: unknown;
  postExamples?: string[];
}

import type { AutonomousConfigLike } from "../types/config-like.ts";

export interface CharacterAutonomousConfigLike extends AutonomousConfigLike {
  agents?: {
    list?: AgentConfigLike[];
  };
}

interface CharacterParseIssueLike {
  path: PropertyKey[];
  message: string;
}

interface CharacterParseErrorLike {
  issues: CharacterParseIssueLike[];
}

type CharacterValidationResult =
  | { success: true; data?: unknown }
  | { success: false; error: CharacterParseErrorLike };

export interface CharacterRouteState {
  runtime: AgentRuntime | null;
  agentName: string;
  config?: CharacterAutonomousConfigLike;
}

export interface CharacterRouteContext extends RouteRequestContext {
  state: CharacterRouteState;
  pickRandomNames: (count: number) => string[];
  saveConfig?: (config: CharacterAutonomousConfigLike) => void;
  validateCharacter: (
    body: Record<string, unknown>,
  ) => CharacterValidationResult;
}

/** Parse the optional character-history limit without silently truncating input. */
export function parseCharacterHistoryLimit(raw: string | null): number | null {
  if (raw === null) return 20;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

type CharacterMessageExample = {
  name: string;
  content: {
    text: string;
    actions?: string[];
  };
};

type CharacterMessageExampleGroup = {
  examples: CharacterMessageExample[];
};

function replaceCharacterNameTokens(value: string, nextName: string): string {
  return value
    .replaceAll("{{agentName}}", nextName)
    .replaceAll("{{name}}", nextName);
}

function shouldRewriteExampleSpeakerName(
  speakerName: string,
  previousName?: string,
): boolean {
  const normalized = speakerName.trim().toLowerCase();
  if (!normalized) return false;

  if (
    normalized === "{{agentname}}" ||
    normalized === "{{name}}" ||
    normalized === "assistant" ||
    normalized === "agent" ||
    normalized === "ai" ||
    normalized === "model"
  ) {
    return true;
  }

  if (previousName?.trim()) {
    return normalized === previousName.trim().toLowerCase();
  }

  return false;
}

function isSnapshotRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rewrite one already-snapshotted example. The input comes from
 * `buildCharacterHistorySnapshot`, so it is inert own data — plain reads,
 * spreads and `.map` here cannot run an accessor or a Proxy trap.
 */
function rewriteSnapshotExample(
  example: unknown,
  nextName: string,
  previousName?: string,
): CharacterMessageExample {
  const base = isSnapshotRecord(example) ? example : {};
  const speakerName = typeof base.name === "string" ? base.name : "";
  const content = isSnapshotRecord(base.content) ? base.content : {};
  const text = typeof content.text === "string" ? content.text : "";

  return {
    ...base,
    name: shouldRewriteExampleSpeakerName(speakerName, previousName)
      ? nextName
      : replaceCharacterNameTokens(speakerName, nextName),
    content: {
      ...content,
      text: replaceCharacterNameTokens(text, nextName),
    },
  } as CharacterMessageExample;
}

/**
 * Rewrite speaker names / name tokens on the trusted snapshot only. Staging
 * snapshots first and rewriting second is what keeps the PUT path
 * descriptor-only: nothing here ever touches the submitted graph.
 */
function rewriteSnapshotMessageExamplesForName(
  messageExamples: unknown,
  nextName: string,
  previousName?: string,
): CharacterMessageExampleGroup[] | undefined {
  if (!Array.isArray(messageExamples)) {
    return undefined;
  }

  return messageExamples.map((group) => {
    const examples =
      isSnapshotRecord(group) && Array.isArray(group.examples)
        ? group.examples
        : [];
    return {
      examples: examples.map((example) =>
        rewriteSnapshotExample(example, nextName, previousName),
      ),
    };
  });
}

type CharacterPutTarget = {
  name?: string;
  username?: string;
  bio?: string | string[];
  system?: string;
  adjectives?: string[];
  topics?: string[];
  style?: unknown;
  messageExamples?: unknown;
  postExamples?: string[];
};

/** Character fields `PUT /api/character` may overlay. */
const CHARACTER_PUT_FIELDS = [
  "name",
  "username",
  "bio",
  "system",
  "adjectives",
  "topics",
  "style",
  "messageExamples",
  "postExamples",
] as const;

type CharacterPutField = (typeof CHARACTER_PUT_FIELDS)[number];

/**
 * Stage the next character by *reference* only: every field is taken from a
 * single own-data-descriptor read of the submitted body, falling back to the
 * live character. No submitted value is traversed here — that happens once, in
 * `buildCharacterHistorySnapshot`, under the walk budget.
 */
function stageCharacterPut(
  character: unknown,
  body: Record<string, unknown>,
): RuntimeCharacterLike {
  const staged: Record<string, unknown> = {};
  for (const field of CHARACTER_PUT_FIELDS) {
    const submitted = readOwnDataValue(body, field);
    staged[field] =
      submitted != null ? submitted : readOwnDataValue(character, field);
  }
  return staged as RuntimeCharacterLike;
}

/**
 * Commit the validated snapshot onto the live character. Only fields the body
 * actually submitted are overwritten (plus message examples on a rename), and
 * every committed value comes from the bounded snapshot rather than the raw
 * request graph.
 */
function commitCharacterSnapshot(
  target: CharacterPutTarget,
  body: Record<string, unknown>,
  snapshot: CharacterHistorySnapshot,
  messageExamples: CharacterMessageExampleGroup[] | undefined,
): void {
  const submitted = new Set<CharacterPutField>();
  for (const field of CHARACTER_PUT_FIELDS) {
    if (readOwnDataValue(body, field) != null) submitted.add(field);
  }

  if (submitted.has("name") && snapshot.name !== undefined) {
    target.name = snapshot.name;
  }
  if (submitted.has("username") && snapshot.username !== undefined) {
    target.username = snapshot.username;
  }
  if (submitted.has("bio") && snapshot.bio !== undefined) {
    target.bio = snapshot.bio;
  }
  if (submitted.has("system") && snapshot.system !== undefined) {
    target.system = snapshot.system;
  }
  if (submitted.has("adjectives") && snapshot.adjectives !== undefined) {
    target.adjectives = snapshot.adjectives;
  }
  if (submitted.has("topics") && snapshot.topics !== undefined) {
    target.topics = snapshot.topics;
  }
  if (submitted.has("style") && snapshot.style !== undefined) {
    target.style = snapshot.style;
  }
  if (submitted.has("postExamples") && snapshot.postExamples !== undefined) {
    target.postExamples = snapshot.postExamples;
  }
  if (
    (submitted.has("messageExamples") || submitted.has("name")) &&
    messageExamples !== undefined
  ) {
    target.messageExamples = messageExamples;
  }
}

function syncRuntimeCharacterToConfig(
  state: CharacterRouteState,
  saveConfig?: (config: CharacterAutonomousConfigLike) => void,
): void {
  const runtime = state.runtime;
  const config = state.config;
  if (!runtime || !config) return;

  if (!config.agents) config.agents = {};
  const existingList = config.agents.list ?? [];
  const primaryAgent: AgentConfigLike = existingList[0] ?? {
    id: "main",
    default: true,
  };
  const character = runtime.character;
  const nextAgent: AgentConfigLike = {
    ...primaryAgent,
    ...(character.name ? { name: character.name } : {}),
    ...(Array.isArray(character.bio) ? { bio: [...character.bio] } : {}),
    ...(typeof character.system === "string"
      ? { system: character.system }
      : {}),
    ...(Array.isArray(character.adjectives)
      ? { adjectives: [...character.adjectives] }
      : {}),
    ...(Array.isArray((character as { topics?: string[] }).topics)
      ? { topics: [...((character as { topics?: string[] }).topics ?? [])] }
      : {}),
    ...(character.style
      ? {
          style: {
            ...(Array.isArray(character.style.all)
              ? { all: [...character.style.all] }
              : {}),
            ...(Array.isArray(character.style.chat)
              ? { chat: [...character.style.chat] }
              : {}),
            ...(Array.isArray(character.style.post)
              ? { post: [...character.style.post] }
              : {}),
          },
        }
      : {}),
    ...(Array.isArray(character.postExamples)
      ? { postExamples: [...character.postExamples] }
      : {}),
    ...(Array.isArray(character.messageExamples)
      ? {
          messageExamples: JSON.parse(
            JSON.stringify(character.messageExamples),
          ),
        }
      : {}),
  };

  config.agents.list = [nextAgent, ...existingList.slice(1)];
  saveConfig?.(config);
}

function buildCharacterSummary(ctx: CharacterGenerateContext): string {
  return [
    ctx.name ? `Name: ${ctx.name}` : "",
    ctx.system ? `System prompt: ${ctx.system}` : "",
    ctx.bio ? `Bio: ${ctx.bio}` : "",
    ctx.topics?.length ? `Topics: ${ctx.topics.join(", ")}` : "",
    ctx.style?.all?.length ? `Style rules: ${ctx.style.all.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildGeneratePrompt(
  field: CharacterGenerateField,
  context: CharacterGenerateContext,
  mode: CharacterGenerateMode | undefined,
): string {
  const charSummary = buildCharacterSummary(context);

  if (field === "bio") {
    return `Given this character:\n${charSummary}\n\nWrite a concise, compelling bio for this character (3-4 short paragraphs, one per line). Use their current interests and info to expand the bio into something more interesting and unique. Just output the bio lines, nothing else. Match the character's voice and personality.`;
  }

  if (field === "system") {
    return `Given this character:\n${charSummary}\n\nWrite a system prompt that defines how this AI agent should behave. The system prompt should be written in first person, describing the agent's personality, communication style, and core behaviors. Include specific guidelines about tone, language style (formal/casual), and any unique quirks. Keep it concise but comprehensive (2-4 paragraphs). Just output the system prompt text, nothing else.`;
  }

  if (field === "style") {
    const existing =
      mode === "append" && context.style?.all?.length
        ? `\nExisting style rules (add to these, don't repeat):\n${context.style.all.join("\n")}`
        : "";
    return `Given this character:\n${charSummary}${existing}\n\nGenerate 4-6 communication style rules for this character. Output a JSON object with keys "all", "chat", "post", each containing an array of short rule strings. Just output the JSON, nothing else.`;
  }

  if (field === "chatExamples") {
    return `Given this character:\n${charSummary}\n\nGenerate 3 example chat conversations showing how this character responds. Output strict JSON only, with no markdown fences and no explanation. The JSON must be an array of conversation groups using this exact schema:\n[\n  {\n    "examples": [\n      { "name": "{{user1}}", "content": { "text": "..." } },\n      { "name": "{{agentName}}", "content": { "text": "..." } }\n    ]\n  }\n]\n\nEach conversation should contain 2-4 turns. Use the "name" field, not "user" or "role". Use content.text strings only.`;
  }

  const existing =
    mode === "append" && context.postExamples?.length
      ? `\nExisting posts (add new ones, don't repeat):\n${context.postExamples.join("\n")}`
      : "";
  return `Given this character:\n${charSummary}${existing}\n\nGenerate 3-5 example social media posts this character would write. Output a JSON array of strings. Just output the JSON array, nothing else.`;
}

const CHARACTER_SCHEMA_FIELDS = [
  {
    key: "name",
    type: "string",
    label: "Name",
    description: "Agent display name",
    maxLength: 100,
  },
  {
    key: "username",
    type: "string",
    label: "Username",
    description: "Agent username for platforms",
    maxLength: 50,
  },
  {
    key: "bio",
    type: "string | string[]",
    label: "Bio",
    description: "Biography — single string or array of points",
  },
  {
    key: "system",
    type: "string",
    label: "System Prompt",
    description: "System prompt defining core behavior",
    maxLength: 10000,
  },
  {
    key: "adjectives",
    type: "string[]",
    label: "Adjectives",
    description: "Personality adjectives (e.g. curious, witty)",
  },
  {
    key: "topics",
    type: "string[]",
    label: "Topics",
    description: "Conversation topics the agent is knowledgeable about",
  },
  {
    key: "style",
    type: "object",
    label: "Style",
    description: "Communication style guides",
    children: [
      {
        key: "all",
        type: "string[]",
        label: "All",
        description: "Style guidelines for all responses",
      },
      {
        key: "chat",
        type: "string[]",
        label: "Chat",
        description: "Style guidelines for chat responses",
      },
      {
        key: "post",
        type: "string[]",
        label: "Post",
        description: "Style guidelines for social media posts",
      },
    ],
  },
  {
    key: "messageExamples",
    type: "array",
    label: "Message Examples",
    description: "Example conversations demonstrating the agent's voice",
  },
  {
    key: "postExamples",
    type: "string[]",
    label: "Post Examples",
    description: "Example social media posts",
  },
] as const;

export async function handleCharacterRoutes(
  ctx: CharacterRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    state,
    saveConfig,
    readJsonBody,
    json,
    error,
    pickRandomNames,
    validateCharacter,
  } = ctx;

  if (method === "GET" && pathname === "/api/character/history") {
    if (!state.runtime) {
      json(res, { history: [], agentName: state.agentName });
      return true;
    }

    const url = new URL(req.url ?? pathname, "http://localhost");
    const limit = parseCharacterHistoryLimit(url.searchParams.get("limit"));
    if (limit === null) {
      error(res, "Invalid character history limit.", 400);
      return true;
    }
    const history = await listCharacterHistory(state.runtime, limit);

    json(res, { history, agentName: state.agentName });
    return true;
  }

  if (method === "GET" && pathname === "/api/character") {
    const runtime = state.runtime;
    const merged: Record<string, unknown> = {};
    if (runtime) {
      const character = runtime.character;
      if (character.name) merged.name = character.name;
      if (character.username) merged.username = character.username;
      if (character.bio) merged.bio = character.bio;
      if (character.system) merged.system = character.system;
      if (character.adjectives) merged.adjectives = character.adjectives;
      if (Array.isArray((character as { topics?: string[] }).topics)) {
        merged.topics = (character as { topics?: string[] }).topics;
      }
      if (character.style) merged.style = character.style;
      if (character.messageExamples) {
        merged.messageExamples = character.messageExamples;
      }
      if (character.postExamples) {
        merged.postExamples = character.postExamples;
      }
    }

    json(res, { character: merged, agentName: state.agentName });
    return true;
  }

  if (method === "PUT" && pathname === "/api/character") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    const result = validateCharacter(body);
    if (!result.success && "error" in result) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      json(res, { ok: false, validationErrors: issues }, 422);
      return true;
    }

    const runtime = state.runtime;
    if (runtime) {
      const character = runtime.character;
      let previousCharacter: CharacterHistorySnapshot;
      try {
        previousCharacter = buildCharacterHistorySnapshot(
          character as RuntimeCharacterLike,
        );
      } catch (err) {
        // error-policy:J3 cyclic/over-deep live character is invalid input.
        if (isCharacterHistoryUnbounded(err)) {
          error(res, "Character payload exceeds the history walk budget", 400);
          return true;
        }
        throw err;
      }
      const liveCharacterName = readOwnDataValue(character, "name");
      const previousCharacterName =
        typeof liveCharacterName === "string" ? liveCharacterName : undefined;
      const submittedName = readOwnDataValue(body, "name");
      const nextStoredCharacterName =
        submittedName != null ? String(submittedName) : previousCharacterName;
      const nextCharacterName =
        typeof submittedName === "string" && submittedName.trim()
          ? submittedName.trim()
          : previousCharacterName?.trim()
            ? previousCharacterName.trim()
            : state.agentName;

      // One bounded, descriptor-only snapshot of the whole next character; the
      // submitted graph is never traversed outside this call.
      let charData: CharacterHistorySnapshot;
      let nextMessageExamples: CharacterMessageExampleGroup[] | undefined;
      try {
        charData = buildCharacterHistorySnapshot(
          stageCharacterPut(character, body),
        );
        const rewritesExamples =
          submittedName != null ||
          readOwnDataValue(body, "messageExamples") != null;
        nextMessageExamples = rewritesExamples
          ? rewriteSnapshotMessageExamplesForName(
              charData.messageExamples,
              nextCharacterName,
              previousCharacterName,
            )
          : undefined;
        if (nextMessageExamples !== undefined) {
          charData = {
            ...charData,
            messageExamples:
              nextMessageExamples as unknown as CharacterHistorySnapshot["messageExamples"],
          };
        }
      } catch (err) {
        // error-policy:J3 Zod-accepted passthrough extras can still overflow.
        if (isCharacterHistoryUnbounded(err)) {
          error(res, "Character payload exceeds the history walk budget", 400);
          return true;
        }
        throw err;
      }

      if (
        nextStoredCharacterName !== undefined &&
        nextStoredCharacterName !== previousCharacterName
      ) {
        invalidateConversationConnectionTopology(runtime);
      }
      commitCharacterSnapshot(
        character as CharacterPutTarget,
        body,
        charData,
        nextMessageExamples,
      );

      // Persist character fields to DB so edits survive restarts
      try {
        await runtime.updateAgent(runtime.agentId, {
          name: character.name,
          metadata: {
            ...(runtime.character as { metadata?: Record<string, unknown> })
              .metadata,
            character: charData,
          },
        });
        await recordCharacterHistory(runtime, {
          previousCharacter,
          nextCharacter: character as RuntimeCharacterLike,
          source: "manual",
        });
      } catch (err) {
        // error-policy:J3 Zod-accepted passthrough extras can still overflow.
        if (isCharacterHistoryUnbounded(err)) {
          error(res, "Character payload exceeds the history walk budget", 400);
          return true;
        }
        throw err;
      }
    }

    syncRuntimeCharacterToConfig(state, saveConfig);

    const submittedAgentName = readOwnDataValue(body, "name");
    if (submittedAgentName) state.agentName = String(submittedAgentName);
    json(res, {
      ok: true,
      character: state.runtime?.character ?? body,
      agentName: state.agentName,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/character/random-name") {
    const names = pickRandomNames(1);
    json(res, { name: names[0] ?? "Reimu" });
    return true;
  }

  if (method === "POST" && pathname === "/api/character/generate") {
    const rawGen = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawGen === null) return true;
    const parsedGen = PostCharacterGenerateRequestSchema.safeParse(rawGen);
    if (!parsedGen.success) {
      error(
        res,
        parsedGen.error.issues[0]?.message ?? "field and context are required",
        400,
      );
      return true;
    }
    const body = parsedGen.data;

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent runtime not available. Start the agent first.", 503);
      return true;
    }

    if (
      body.field !== "bio" &&
      body.field !== "system" &&
      body.field !== "style" &&
      body.field !== "chatExamples" &&
      body.field !== "postExamples"
    ) {
      error(res, `Unknown field: ${body.field}`, 400);
      return true;
    }

    const prompt = buildGeneratePrompt(body.field, body.context, body.mode);

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      temperature: 0.8,
      maxTokens: 1500,
    });
    json(res, { generated: String(result) });
    return true;
  }

  if (method === "GET" && pathname === "/api/character/schema") {
    json(res, { fields: CHARACTER_SCHEMA_FIELDS });
    return true;
  }

  return false;
}
