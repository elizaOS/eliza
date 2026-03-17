import type { AgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import type { RouteRequestContext } from "./route-helpers";

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

interface AutonomousConfigLike {
  agents?: {
    list?: AgentConfigLike[];
  };
}

interface CharacterParseIssueLike {
  path: Array<string | number>;
  message: string;
}

interface CharacterParseErrorLike {
  issues: CharacterParseIssueLike[];
}

type CharacterValidationResult =
  | { success: true }
  | { success: false; error: CharacterParseErrorLike };

export interface CharacterRouteState {
  runtime: AgentRuntime | null;
  agentName: string;
  config?: AutonomousConfigLike;
}

export interface CharacterRouteContext extends RouteRequestContext {
  state: CharacterRouteState;
  pickRandomNames: (count: number) => string[];
  saveConfig?: (config: AutonomousConfigLike) => void;
  validateCharacter: (
    body: Record<string, unknown>,
  ) => CharacterValidationResult;
}

function syncRuntimeCharacterToConfig(
  state: CharacterRouteState,
  saveConfig?: (config: AutonomousConfigLike) => void,
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
    return `Given this character:\n${charSummary}\n\nGenerate 3 example chat conversations showing how this character responds. Output a JSON array where each element is an array of message objects like [{"user":"{{user1}}","content":{"text":"..."}},{"user":"{{agentName}}","content":{"text":"..."}}]. Just output the JSON array, nothing else.`;
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
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      json(res, { ok: false, validationErrors: issues }, 422);
      return true;
    }

    if (state.runtime) {
      const character = state.runtime.character;
      if (body.name != null) character.name = String(body.name);
      if (body.username != null) character.username = String(body.username);
      if (body.bio != null) {
        character.bio = Array.isArray(body.bio)
          ? (body.bio as string[])
          : [String(body.bio)];
      }
      if (body.system != null) character.system = String(body.system);
      if (body.adjectives != null) {
        character.adjectives = body.adjectives as string[];
      }
      if (body.topics != null) {
        (character as { topics?: string[] }).topics = body.topics as string[];
      }
      if (body.style != null) {
        character.style = body.style as NonNullable<typeof character.style>;
      }
      if (body.messageExamples != null) {
        character.messageExamples = body.messageExamples as NonNullable<
          typeof character.messageExamples
        >;
      }
      if (body.postExamples != null) {
        character.postExamples = body.postExamples as string[];
      }
    }

    try {
      syncRuntimeCharacterToConfig(state, saveConfig);
    } catch (err) {
      error(
        res,
        err instanceof Error
          ? `Failed to persist character: ${err.message}`
          : "Failed to persist character",
        500,
      );
      return true;
    }

    if (body.name) state.agentName = String(body.name);
    json(res, { ok: true, character: body, agentName: state.agentName });
    return true;
  }

  if (method === "GET" && pathname === "/api/character/random-name") {
    const names = pickRandomNames(1);
    json(res, { name: names[0] ?? "Reimu" });
    return true;
  }

  if (method === "POST" && pathname === "/api/character/generate") {
    const body = await readJsonBody<{
      field: CharacterGenerateField;
      context: CharacterGenerateContext;
      mode?: CharacterGenerateMode;
    }>(req, res);
    if (!body) return true;

    if (!body.field || !body.context) {
      error(res, "field and context are required", 400);
      return true;
    }

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

    try {
      const result = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0.8,
        maxTokens: 1500,
      });
      json(res, { generated: String(result) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "generation failed";
      logger.error(`[character-generate] ${message}`);
      error(res, message, 500);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/character/schema") {
    json(res, { fields: CHARACTER_SCHEMA_FIELDS });
    return true;
  }

  return false;
}
