/**
 * Synthetic dataset generator for fine-tuning the shouldRespond + context-routing
 * messageHandler router and the action planner.
 *
 * Architecture:
 * 1. Takes scenario blueprints and expands each into N variants
 * 2. Uses a teacher model (Claude/GPT-5) to generate realistic conversations
 * 3. Randomizes agent name per sample to prevent statistical pollution
 * 4. Exports in eliza_native_v1 model-boundary JSONL format
 *
 * Teacher model selection:
 * - ANTHROPIC_API_KEY → Claude Sonnet 4
 * - OPENAI_API_KEY → GPT-5 / GPT-4o
 * - Falls back to whichever is available
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import type { IAgentRuntime, RecordLlmCallDetails } from "@elizaos/core";
import * as ElizaCore from "@elizaos/core";
import {
  buildElizaNativeTrajectoryRows,
  ELIZA_NATIVE_TRAJECTORY_FORMAT,
  type ElizaNativeTrajectoryRow,
  iterateTrajectoryLlmCalls,
} from "@elizaos/core";
import {
  ACTION_CONTEXT_MAP,
  ALL_CONTEXTS,
  PROVIDER_CONTEXT_MAP,
} from "./context-catalog.js";
import type { AgentContext } from "./context-types.js";
import {
  ALL_BLUEPRINTS,
  type ScenarioBlueprint,
} from "./scenario-blueprints.js";

const SHOULD_RESPOND_PROMPT_TEMPLATE = `task: Decide whether {{agentName}} should respond, ignore, or stop.

context:
{{providers}}

available_contexts:
{{availableContexts}}

rules[6]:
- direct mention of {{agentName}} -> RESPOND
- different assistant name or talking to someone else -> IGNORE unless {{agentName}} is also directly addressed
- prior participation by {{agentName}} in the thread is not enough by itself; the newest message must still clearly expect {{agentName}} -> otherwise IGNORE
- request to stop or be quiet directed at {{agentName}} -> STOP
- if multiple people are mentioned and {{agentName}} is one of the addressees -> RESPOND
- if unsure whether the speaker is talking to {{agentName}}, prefer IGNORE over hallucinating relevance

message_handler:
- action: RESPOND, IGNORE, or STOP
- simple: true only when the reply can be sent directly without planner/tool context
- contexts: list of available_contexts needed for planner/tool/provider work; [] for direct replies, IGNORE, or STOP
- thought: short internal routing rationale
- reply: optional direct user-visible reply when contexts is []

decision_note:
- respond only when the latest message is talking TO {{agentName}}
- talking TO {{agentName}} means name mention, reply chain, or a clear follow-up that still expects {{agentName}} to answer
- casual conversation between other users is not enough
- if another assistant already answered and nobody re-addressed {{agentName}}, IGNORE
- if {{agentName}} already replied recently and nobody re-addressed {{agentName}}, IGNORE
- talking ABOUT {{agentName}} or continuing a room conversation around them is not enough

output:
JSON object only. No prose, markdown, XML, or hidden reasoning.

Example:
{"messageHandler":{"action":"RESPOND","simple":false,"contexts":["wallet"],"thought":"Direct mention and clear follow-up needs wallet context.","reply":""}}

Example:
{"messageHandler":{"action":"IGNORE","simple":false,"contexts":[],"thought":"The latest message is not addressed to {{agentName}}.","reply":""}}`;

// ==================== Types ====================

export interface TrainingSample {
  /** Unique sample ID */
  id: string;
  /** Source blueprint ID */
  blueprintId: string;
  /** The randomized agent name used in this sample */
  agentName: string;
  /** The conversation messages (multi-turn) */
  messages: ConversationMessage[];
  /** Expected messageHandler routing output */
  expectedOutput: RoutingOutput;
  /** Metadata for filtering/analysis */
  metadata: SampleMetadata;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  /** Speaker name (for group chat context) */
  name?: string;
  content: string;
}

export interface RoutingOutput {
  decision: "RESPOND" | "IGNORE" | "STOP";
  primaryContext: AgentContext;
  secondaryContexts: AgentContext[];
  reasoning: string;
  expectedAction?: string;
}

export interface MessageHandlerTrainingOutput {
  messageHandler: {
    action: RoutingOutput["decision"];
    simple: boolean;
    contexts: AgentContext[];
    thought: string;
    reply: string;
  };
}

export interface SampleMetadata {
  platform: string;
  pattern: string;
  turnCount: number;
  generatedBy: string;
  generatedAt: string;
  variant: number;
  totalVariants: number;
}

export type ElizaNativeTrainingExample = ElizaNativeTrajectoryRow;

// ==================== Name pools ====================

const AGENT_NAMES = [
  "Nova",
  "Kai",
  "Echo",
  "Luna",
  "Atlas",
  "Vex",
  "Iris",
  "Cypher",
  "Sage",
  "Bolt",
  "Pixel",
  "Nyx",
  "Orion",
  "Zephyr",
  "Flux",
  "Aria",
  "Cosmo",
  "Dash",
  "Ember",
  "Ghost",
  "Helix",
  "Jade",
  "Karma",
  "Lux",
  "Muse",
  "Neo",
  "Onyx",
  "Proto",
  "Qubit",
  "Rune",
  "Spark",
  "Titan",
  "Uno",
  "Volt",
  "Wren",
  "Xeno",
  "Yara",
  "Zen",
  "Chip",
  "Delta",
  "Ava",
  "Rex",
  "Sky",
  "Zara",
];

const PARTICIPANT_NAMES = [
  "Alice",
  "Bob",
  "Charlie",
  "Dave",
  "Eve",
  "Frank",
  "Grace",
  "Hank",
  "Ivy",
  "Jack",
  "Karen",
  "Leo",
  "Mia",
  "Nick",
  "Olivia",
  "Pete",
  "Quinn",
  "Rose",
  "Sam",
  "Tina",
  "Uma",
  "Vince",
  "Wendy",
  "Xavier",
  "Yuki",
  "Zack",
  "Maya",
  "Raj",
  "Sofia",
  "Tyler",
  "Aisha",
  "Ben",
  "Chloe",
  "Dan",
  "Elena",
  "Finn",
  "Gabe",
  "Hannah",
  "Isaac",
  "Jade",
];

const OTHER_BOT_NAMES = [
  "AssistBot",
  "Helper",
  "Cortana",
  "Alexa",
  "Siri",
  "Bard",
  "CoPilot",
  "Genie",
  "Oracle",
  "Alfred",
  "Jarvis",
  "Friday",
];

const PLATFORMS = ["telegram", "discord", "slack", "matrix", "irc"];

// ==================== Teacher model interface ====================

export interface TeacherModel {
  name: string;
  generate(systemPrompt: string, userPrompt: string): Promise<string>;
}

const recordLlmCall =
  "recordLlmCall" in ElizaCore && typeof ElizaCore.recordLlmCall === "function"
    ? ElizaCore.recordLlmCall
    : async <T>(
        _runtime: IAgentRuntime | undefined,
        _details: RecordLlmCallDetails,
        callback: () => Promise<T> | T,
      ): Promise<T> => await callback();

const withStandaloneTrajectory =
  "withStandaloneTrajectory" in ElizaCore &&
  typeof ElizaCore.withStandaloneTrajectory === "function"
    ? ElizaCore.withStandaloneTrajectory
    : async <T>(
        _runtime: IAgentRuntime | undefined,
        _options: Record<string, unknown>,
        callback: () => Promise<T>,
      ): Promise<T> => await callback();

/**
 * Create a teacher model using the Anthropic API.
 */
export function createAnthropicTeacher(
  apiKey: string,
  runtime?: IAgentRuntime,
): TeacherModel {
  return {
    name: "anthropic/claude-sonnet-4.6",
    async generate(systemPrompt: string, userPrompt: string): Promise<string> {
      return await withStandaloneTrajectory(
        runtime,
        {
          source: "training",
          metadata: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            purpose: "teacher",
          },
        },
        async () => {
          const details: RecordLlmCallDetails = {
            model: "anthropic/claude-sonnet-4.6",
            modelVersion: "claude-sonnet-4-6",
            systemPrompt,
            userPrompt,
            temperature: 1,
            maxTokens: 4096,
            purpose: "training.teacher",
            actionType: "training.teacher.anthropic.generate",
          };
          return await recordLlmCall(runtime, details, async () => {
            const response = await fetch(
              "https://api.anthropic.com/v1/messages",
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-api-key": apiKey,
                  "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                  model: "claude-sonnet-4-6",
                  max_tokens: 4096,
                  temperature: 1,
                  system: systemPrompt,
                  messages: [{ role: "user", content: userPrompt }],
                }),
              },
            );
            if (!response.ok) {
              throw new Error(
                `Anthropic API error: ${response.status} ${await response.text()}`,
              );
            }
            const data = (await response.json()) as {
              content: Array<{ type: string; text: string }>;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
              };
            };
            details.promptTokens = data.usage?.input_tokens;
            details.completionTokens = data.usage?.output_tokens;
            return data.content[0]?.text ?? "";
          });
        },
      );
    },
  };
}

/**
 * Create a teacher model using the OpenAI API.
 */
export function createOpenAITeacher(
  apiKey: string,
  runtime?: IAgentRuntime,
): TeacherModel {
  return {
    name: "openai/gpt-5.4",
    async generate(systemPrompt: string, userPrompt: string): Promise<string> {
      return await withStandaloneTrajectory(
        runtime,
        {
          source: "training",
          metadata: {
            provider: "openai",
            model: "gpt-5.4",
            purpose: "teacher",
          },
        },
        async () => {
          const details: RecordLlmCallDetails = {
            model: "openai/gpt-5.4",
            modelVersion: "gpt-5.4",
            systemPrompt,
            userPrompt,
            temperature: 0.9,
            maxTokens: 4096,
            purpose: "training.teacher",
            actionType: "training.teacher.openai.generate",
          };
          return await recordLlmCall(runtime, details, async () => {
            const response = await fetch(
              "https://api.openai.com/v1/chat/completions",
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                  model: "gpt-5.4",
                  messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                  ],
                  max_tokens: 4096,
                  temperature: 0.9,
                }),
              },
            );
            if (!response.ok) {
              throw new Error(
                `OpenAI API error: ${response.status} ${await response.text()}`,
              );
            }
            const data = (await response.json()) as {
              model?: string;
              choices: Array<{ message: { content: string } }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
              };
            };
            details.modelVersion = data.model;
            details.promptTokens = data.usage?.prompt_tokens;
            details.completionTokens = data.usage?.completion_tokens;
            return data.choices[0]?.message?.content ?? "";
          });
        },
      );
    },
  };
}

/**
 * Create a teacher model that talks to Cerebras (gpt-oss-120b by default).
 *
 * This is the standing default for lifeops training: the teacher generates
 * synthetic conversations, not the agent's responses. The agent under test
 * still runs on Anthropic Opus 4.7. We never use the agent's provider to
 * generate training data for itself.
 */
export function createCerebrasTeacher(runtime?: IAgentRuntime): TeacherModel {
  const model =
    process.env.TRAIN_MODEL?.trim() ??
    process.env.CEREBRAS_MODEL?.trim() ??
    "gpt-oss-120b";
  return {
    name: `cerebras/${model}`,
    async generate(systemPrompt: string, userPrompt: string): Promise<string> {
      return await withStandaloneTrajectory(
        runtime,
        {
          source: "training",
          metadata: { provider: "cerebras", model, purpose: "teacher" },
        },
        async () => {
          const details: RecordLlmCallDetails = {
            model: `cerebras/${model}`,
            modelVersion: model,
            systemPrompt,
            userPrompt,
            temperature: 0.9,
            maxTokens: 4096,
            purpose: "training.teacher",
            actionType: "training.teacher.cerebras.generate",
          };
          return await recordLlmCall(runtime, details, async () => {
            const { getTrainingModelClient } = await import(
              "./cerebras-eval-model.js"
            );
            const client = getTrainingModelClient();
            const result = await client({
              prompt: userPrompt,
              systemPrompt,
              temperature: 0.9,
              maxTokens: 4096,
            });
            details.promptTokens = result.usage?.promptTokens;
            details.completionTokens = result.usage?.completionTokens;
            return result.text;
          });
        },
      );
    },
  };
}

// ==================== Randomization utilities ====================

function pickRandom<T>(arr: T[]): T {
  const value = arr[Math.floor(Math.random() * arr.length)];
  if (value === undefined) {
    throw new Error("Cannot pick a random value from an empty array");
  }
  return value;
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function randomAgentName(exclude: string[] = []): string {
  const available = AGENT_NAMES.filter(
    (n) => !exclude.map((e) => e.toLowerCase()).includes(n.toLowerCase()),
  );
  return pickRandom(available.length > 0 ? available : AGENT_NAMES);
}

function randomParticipants(count: number, exclude: string[] = []): string[] {
  const available = PARTICIPANT_NAMES.filter(
    (n) => !exclude.map((e) => e.toLowerCase()).includes(n.toLowerCase()),
  );
  return pickN(available, count);
}

// ==================== Prompt construction ====================

function buildTeacherSystemPrompt(): string {
  return `You are a synthetic data generator for training an AI agent's v5 messageHandler router.
Your task is to generate realistic multi-turn group chat conversations.

IMPORTANT RULES:
1. Output ONLY a JSON object. No markdown, no explanation, no preamble.
2. Each message must have "name" (speaker name) and "content" (message text).
3. Messages should feel natural - casual, varied length, sometimes with typos.
4. Group chats should have 3-6 participants plus optionally the agent.
5. The agent's messages (when present) should be clearly from an AI assistant.
6. NEVER include the expected messageHandler routing output in the conversation itself.
7. Messages should be diverse in tone: some short, some long, some with emoji.

Output format:
{"messages":[{"name":"Alice","content":"hey everyone"},{"name":"Bob","content":"what's up"}]}`;
}

function buildTeacherUserPrompt(
  blueprint: ScenarioBlueprint,
  agentName: string,
  participants: string[],
  platform: string,
  otherBotName?: string,
  variant: number = 0,
): string {
  const turnRange = `${blueprint.minContextTurns}-${blueprint.maxContextTurns}`;
  const participantList = participants.join(", ");

  let extraInstructions = "";

  if (blueprint.pattern === "group_wrong_agent" && otherBotName) {
    extraInstructions = `There is ANOTHER bot named "${otherBotName}" in the chat. Someone addresses "${otherBotName}" (not "${agentName}"). "${agentName}" should NOT be addressed.`;
  }

  if (blueprint.pattern === "group_about_agent") {
    extraInstructions = `People talk ABOUT "${agentName}" in third person ("the bot", "it", "${agentName} can do X") but NEVER address it directly. No "@${agentName}" or "${agentName}, can you...".`;
  }

  if (blueprint.pattern === "group_noise") {
    extraInstructions = `"${agentName}" should NOT appear in any message at all. This is pure human conversation.`;
  }

  if (blueprint.pattern === "group_action_emergence") {
    extraInstructions = `The intent to perform an action should emerge GRADUALLY over multiple messages. Users discuss the topic, one user's intent builds up, and finally they ask the agent to execute. The last 1-2 messages should clearly direct the agent.`;
  }

  if (blueprint.pattern === "group_multi_turn_intent") {
    extraInstructions = `The action intent should build across 3+ messages from the same user. They start by observing/discussing, then express desire, then finally ask the agent to act.`;
  }

  const keywordsHint =
    blueprint.groundingKeywords.length > 0
      ? `Try to naturally include some of these words/phrases: ${blueprint.groundingKeywords.join(", ")}`
      : "";

  return `Generate variant #${variant + 1} of a ${platform} group chat conversation.

SCENARIO: ${blueprint.description}
AGENT NAME: ${agentName}
PARTICIPANTS: ${participantList}
PLATFORM: ${platform}
TARGET TURNS: ${turnRange} messages
CONVERSATION PATTERN: ${blueprint.pattern}
${keywordsHint}
${extraInstructions}

${blueprint.generationHint}

Remember:
- Output ONLY a JSON object with a messages array
- Each message has "name" and "content"
- Make it feel natural and realistic
- Vary message lengths and tones
- The last message should be the one the messageHandler router evaluates`;
}

function stripOutputFences(raw: string): string {
  return raw
    .replace(/^```[a-z0-9_-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseTeacherJsonMessages(raw: string): {
  messages: Array<{ name: string; content: string }>;
} {
  const cleaned = stripOutputFences(raw);
  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Teacher output must be a JSON object");
  }
  const messages = (parsed as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) {
    throw new Error("Teacher JSON output must include a messages array");
  }
  const parsedMessages = messages
    .filter(
      (message): message is Record<string, unknown> =>
        Boolean(message) &&
        typeof message === "object" &&
        !Array.isArray(message),
    )
    .map((message) => ({
      name: String(message.name ?? "").trim(),
      content: String(message.content ?? "").trim(),
    }))
    .filter((message) => message.name.length > 0 && message.content.length > 0);
  if (parsedMessages.length === 0) {
    throw new Error("Teacher JSON output did not include valid messages");
  }
  return {
    messages: parsedMessages,
  };
}

function parseTeacherLegacyMessages(raw: string): {
  messages: Array<{ name: string; content: string }>;
} {
  const text = stripOutputFences(raw);
  const lines = text.split(/\r?\n/);
  const messages: Array<{ name: string; content: string }> = [];
  let current: { name?: string; content?: string } | null = null;

  const flush = () => {
    if (current?.name && current.content !== undefined) {
      messages.push({
        name: current.name.trim(),
        content: current.content.trim(),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^messages(?::|\[)/i.test(trimmed)) continue;

    const rowMatch = trimmed.match(/^-\s*([^|:]+?)\s*\|\s*(.*)$/);
    if (rowMatch) {
      flush();
      messages.push({
        name: (rowMatch[1] ?? "").trim(),
        content: (rowMatch[2] ?? "").trim(),
      });
      continue;
    }

    const itemNameMatch = trimmed.match(/^-\s*name:\s*(.*)$/i);
    if (itemNameMatch) {
      flush();
      current = { name: (itemNameMatch[1] ?? "").trim() };
      continue;
    }

    const nameMatch = trimmed.match(/^name:\s*(.*)$/i);
    if (nameMatch) {
      current ??= {};
      current.name = (nameMatch[1] ?? "").trim();
      continue;
    }

    const contentMatch = trimmed.match(/^content:\s*(.*)$/i);
    if (contentMatch) {
      current ??= {};
      current.content = (contentMatch[1] ?? "").trim();
    }
  }

  flush();

  if (messages.length === 0) {
    throw new Error("No teacher messages found in legacy output");
  }

  return { messages };
}

// ==================== Core generation ====================

/**
 * Generate a single training sample from a blueprint.
 */
export async function generateSample(
  blueprint: ScenarioBlueprint,
  teacher: TeacherModel,
  variant: number,
  totalVariants: number,
): Promise<TrainingSample> {
  const agentName = randomAgentName();
  const participantCount = 3 + Math.floor(Math.random() * 3); // 3-5
  const participants = randomParticipants(participantCount, [agentName]);
  const platform = pickRandom(PLATFORMS);
  const otherBotName =
    blueprint.pattern === "group_wrong_agent"
      ? pickRandom(OTHER_BOT_NAMES)
      : undefined;

  const systemPrompt = buildTeacherSystemPrompt();
  const userPrompt = buildTeacherUserPrompt(
    blueprint,
    agentName,
    participants,
    platform,
    otherBotName,
    variant,
  );

  const raw = await teacher.generate(systemPrompt, userPrompt);

  // Parse the teacher's output
  let parsed: { messages: Array<{ name: string; content: string }> };
  try {
    parsed = parseTeacherJsonMessages(raw);
  } catch {
    try {
      parsed = parseTeacherLegacyMessages(raw);
    } catch {
      // If parsing fails, create a minimal sample
      const [firstParticipant = "Alice", secondParticipant = "Bob"] =
        participants;
      parsed = {
        messages: [
          { name: firstParticipant, content: "Hey everyone" },
          {
            name: secondParticipant,
            content:
              blueprint.decision === "RESPOND"
                ? `${agentName}, can you help?`
                : "What's for lunch?",
          },
        ],
      };
    }
  }

  // Convert to training format
  const messages: ConversationMessage[] = parsed.messages.map((m) => ({
    role:
      m.name.trim().toLowerCase() === agentName.trim().toLowerCase()
        ? ("assistant" as const)
        : ("user" as const),
    name: m.name,
    content: m.content,
  }));

  const expectedOutput: RoutingOutput = {
    decision: blueprint.decision,
    primaryContext: blueprint.primaryContext,
    secondaryContexts: blueprint.secondaryContexts ?? [],
    reasoning: blueprint.description,
    expectedAction: blueprint.expectedAction,
  };

  return {
    id: randomUUID(),
    blueprintId: blueprint.id,
    agentName,
    messages,
    expectedOutput,
    metadata: {
      platform,
      pattern: blueprint.pattern,
      turnCount: messages.length,
      generatedBy: teacher.name,
      generatedAt: new Date().toISOString(),
      variant,
      totalVariants,
    },
  };
}

// ==================== Batch generation ====================

export interface GenerationConfig {
  /** Number of variants per blueprint */
  variantsPerBlueprint: number;
  /** Teacher model to use */
  teacher: TeacherModel;
  /** Output directory */
  outputDir: string;
  /** Optional filter: only generate for these contexts */
  filterContexts?: AgentContext[];
  /** Optional filter: only generate for these decisions */
  filterDecisions?: Array<"RESPOND" | "IGNORE" | "STOP">;
  /** Optional hard cap on the number of canonical blueprints to expand */
  limitBlueprints?: number;
  /** Concurrency limit for teacher API calls */
  concurrency?: number;
  /** Progress callback */
  onProgress?: (
    completed: number,
    total: number,
    sample: TrainingSample,
  ) => void;
}

/**
 * Generate the full synthetic dataset.
 */
export async function generateDataset(
  config: GenerationConfig,
): Promise<TrainingSample[]> {
  let blueprints = ALL_BLUEPRINTS;

  if (config.filterContexts) {
    const ctxSet = new Set(config.filterContexts);
    blueprints = blueprints.filter(
      (b) =>
        ctxSet.has(b.primaryContext) ||
        b.secondaryContexts?.some((c) => ctxSet.has(c)),
    );
  }

  if (config.filterDecisions) {
    const decSet = new Set(config.filterDecisions);
    blueprints = blueprints.filter((b) => decSet.has(b.decision));
  }

  if (config.limitBlueprints && config.limitBlueprints > 0) {
    blueprints = blueprints.slice(0, config.limitBlueprints);
  }

  const totalSamples = blueprints.length * config.variantsPerBlueprint;
  const samples: TrainingSample[] = [];
  let completed = 0;

  const concurrency = config.concurrency ?? 5;

  // Process in batches to respect concurrency
  const tasks: Array<() => Promise<TrainingSample>> = [];
  for (const blueprint of blueprints) {
    for (let v = 0; v < config.variantsPerBlueprint; v++) {
      tasks.push(() =>
        generateSample(
          blueprint,
          config.teacher,
          v,
          config.variantsPerBlueprint,
        ),
      );
    }
  }

  // Execute with concurrency limit
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map((fn) => fn()));

    for (const result of results) {
      completed++;
      if (result.status === "fulfilled") {
        samples.push(result.value);
        config.onProgress?.(completed, totalSamples, result.value);
      } else {
        console.error(`Failed to generate sample: ${result.reason}`);
      }
    }
  }

  return samples;
}

// ==================== Export formats ====================

/**
 * Convert a training sample to the canonical Eliza native model-boundary format.
 * The system message contains the shouldRespond prompt template,
 * the user message contains the conversation, and response.text contains the
 * expected native JSON output.
 */
export function toElizaNativeFormat(
  sample: TrainingSample,
  includeContextRouting: boolean = true,
): ElizaNativeTrainingExample {
  const systemContent = buildShouldRespondSystemPrompt(
    sample,
    includeContextRouting,
  );
  const userContent = buildShouldRespondUserPrompt(sample);
  const responseText = buildMessageHandlerJsonResponse(
    sample,
    includeContextRouting,
  );

  return {
    format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
    schemaVersion: 1,
    boundary: "vercel_ai_sdk.generateText",
    trajectoryId: sample.id,
    agentId: sample.agentName,
    source: "app-training",
    status: "completed",
    stepId: `${sample.id}:message-handler`,
    callId: `${sample.id}:message-handler:call-1`,
    stepIndex: 0,
    callIndex: 0,
    timestamp: Date.parse(sample.metadata.generatedAt) || Date.now(),
    purpose: "should_respond",
    actionType: "app-training.synthetic.message_handler",
    stepType: includeContextRouting ? "context_routing" : "should_respond",
    tags: ["synthetic", "message_handler"],
    model: "teacher",
    request: {
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: userContent },
      ],
    },
    response: {
      text: responseText,
    },
    metadata: {
      task_type: includeContextRouting ? "context_routing" : "should_respond",
      source_dataset: "app_training_synthetic",
      trajectory_id: sample.id,
      step_id: `${sample.id}:message-handler`,
      call_id: `${sample.id}:message-handler:call-1`,
      agent_id: sample.agentName,
      blueprint_id: sample.blueprintId,
      platform: sample.metadata.platform,
      pattern: sample.metadata.pattern,
    },
    trajectoryTotals: {
      stepCount: 1,
      llmCallCount: 1,
      providerAccessCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    cacheStats: {
      totalInputTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cachedCallCount: 0,
      cacheReadCallCount: 0,
      cacheWriteCallCount: 0,
      tokenUsageEstimatedCallCount: 0,
    },
  };
}

function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/{{(\w+)}}/g, (_match, key) => values[key] ?? "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function listContextsForSample(sample: TrainingSample): AgentContext[] {
  const contexts = new Set<AgentContext>([
    "general",
    sample.expectedOutput.primaryContext,
    ...sample.expectedOutput.secondaryContexts,
  ]);

  if (sample.expectedOutput.expectedAction) {
    for (const actionContext of ACTION_CONTEXT_MAP[
      sample.expectedOutput.expectedAction
    ] ?? []) {
      contexts.add(actionContext);
    }
  }

  return [...contexts];
}

function listMessageHandlerContextsForSample(
  sample: TrainingSample,
): AgentContext[] {
  const contexts = new Set<AgentContext>([
    sample.expectedOutput.primaryContext,
    ...sample.expectedOutput.secondaryContexts,
  ]);

  if (sample.expectedOutput.expectedAction) {
    for (const actionContext of ACTION_CONTEXT_MAP[
      sample.expectedOutput.expectedAction
    ] ?? []) {
      contexts.add(actionContext);
    }
  }

  contexts.delete("general");
  return [...contexts];
}

function getRelevantActions(sample: TrainingSample): string[] {
  const activeContexts = new Set(listContextsForSample(sample));
  const contextualActions = Object.entries(ACTION_CONTEXT_MAP)
    .filter(([, contexts]) =>
      contexts.some((context) => activeContexts.has(context)),
    )
    .map(([actionName]) => actionName);

  return uniqueStrings([
    sample.expectedOutput.expectedAction ?? "",
    ...contextualActions,
  ]).slice(0, 18);
}

function getRelevantProviders(sample: TrainingSample): string[] {
  const activeContexts = new Set(listContextsForSample(sample));
  return Object.entries(PROVIDER_CONTEXT_MAP)
    .filter(([, contexts]) =>
      contexts.some((context) => activeContexts.has(context)),
    )
    .map(([providerName]) => providerName)
    .slice(0, 12);
}

function buildProvidersBlock(sample: TrainingSample): string {
  const actions = getRelevantActions(sample);
  const providers = getRelevantProviders(sample);

  return [
    `platform: ${sample.metadata.platform}`,
    "actions:",
    ...(actions.length > 0 ? actions : ["REPLY"]).map(
      (action) => `- ${action}`,
    ),
    "providers:",
    ...(providers.length > 0 ? providers : ["recentMessages"]).map(
      (provider) => `- ${provider}`,
    ),
  ].join("\n");
}

function buildShouldRespondSystemPrompt(
  sample: TrainingSample,
  includeContextRouting: boolean,
): string {
  const baseTemplate = includeContextRouting
    ? SHOULD_RESPOND_PROMPT_TEMPLATE
    : SHOULD_RESPOND_PROMPT_TEMPLATE.replace(
        /\nmessage_handler:[\s\S]*?\ndecision_note:/m,
        "\ndecision_note:",
      ).replace(
        /\nExample:\n\{"messageHandler":\{"action":"RESPOND"[\s\S]*$/m,
        '\nExample:\n{"messageHandler":{"action":"RESPOND","simple":true,"contexts":[],"thought":"Direct mention can be answered directly.","reply":""}}',
      );

  return renderTemplate(baseTemplate, {
    agentName: sample.agentName,
    providers: buildProvidersBlock(sample),
    availableContexts: listContextsForSample(sample).join(", "),
  }).trim();
}

function buildShouldRespondUserPrompt(sample: TrainingSample): string {
  const conversationLines = sample.messages
    .map((message, index) => {
      const turnId = `turn-${String(index + 1).padStart(3, "0")}`;
      const speaker =
        message.role === "assistant"
          ? sample.agentName
          : (message.name ?? "user");
      return `[${turnId}] ${speaker}: ${message.content}`;
    })
    .join("\n");

  return [
    `platform: ${sample.metadata.platform}`,
    `agent_name: ${sample.agentName}`,
    "conversation:",
    conversationLines,
    "decision_target: evaluate the final message in this group-chat window.",
  ].join("\n");
}

function buildMessageHandlerJsonResponse(
  sample: TrainingSample,
  includeContextRouting: boolean,
): string {
  const contexts =
    includeContextRouting && sample.expectedOutput.decision === "RESPOND"
      ? listMessageHandlerContextsForSample(sample)
      : [];
  const output: MessageHandlerTrainingOutput = {
    messageHandler: {
      action: sample.expectedOutput.decision,
      simple:
        sample.expectedOutput.decision === "RESPOND" && contexts.length === 0,
      contexts,
      thought: sample.expectedOutput.reasoning,
      reply: "",
    },
  };

  return JSON.stringify(output);
}

function normalizeMessageHandlerJson(response: string): string | null {
  const trimmed = response
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const candidate =
      record.messageHandler &&
      typeof record.messageHandler === "object" &&
      !Array.isArray(record.messageHandler)
        ? (record.messageHandler as Record<string, unknown>)
        : record;
    const action = candidate.action;
    if (action !== "RESPOND" && action !== "IGNORE" && action !== "STOP") {
      return null;
    }
    const contexts = Array.isArray(candidate.contexts)
      ? candidate.contexts.filter(
          (context): context is AgentContext => typeof context === "string",
        )
      : [];
    return JSON.stringify({
      messageHandler: {
        action,
        simple:
          typeof candidate.simple === "boolean"
            ? candidate.simple
            : action === "RESPOND" && contexts.length === 0,
        contexts,
        thought: typeof candidate.thought === "string" ? candidate.thought : "",
        reply: typeof candidate.reply === "string" ? candidate.reply : "",
      },
    });
  } catch {
    return null;
  }
}

/**
 * Export the full dataset to JSONL files for Eliza native model-boundary tuning.
 * Creates separate files for should_respond and context_routing.
 */
export async function exportToElizaNativeJSONL(
  samples: TrainingSample[],
  outputDir: string,
): Promise<{
  shouldRespondPath: string;
  contextRoutingPath: string;
  combinedPath: string;
}> {
  await mkdir(outputDir, { recursive: true });

  // Combined (shouldRespond + context routing)
  const combinedPath = join(outputDir, "combined_training.eliza-native.jsonl");
  const combinedLines = samples
    .map((s) => JSON.stringify(toElizaNativeFormat(s, true)))
    .join("\n");
  await writeFile(combinedPath, `${combinedLines}\n`);

  // shouldRespond only (no context routing — for Flash Lite)
  const shouldRespondPath = join(
    outputDir,
    "should_respond_training.eliza-native.jsonl",
  );
  const srLines = samples
    .map((s) => JSON.stringify(toElizaNativeFormat(s, false)))
    .join("\n");
  await writeFile(shouldRespondPath, `${srLines}\n`);

  // Context routing only (for samples where decision is RESPOND)
  const contextRoutingPath = join(
    outputDir,
    "context_routing_training.eliza-native.jsonl",
  );
  const crLines = samples
    .filter((s) => s.expectedOutput.decision === "RESPOND")
    .map((s) => JSON.stringify(toElizaNativeFormat(s, true)))
    .join("\n");
  await writeFile(contextRoutingPath, `${crLines}\n`);

  // Also write the raw samples for analysis
  const rawPath = join(outputDir, "raw_samples.json");
  await writeFile(rawPath, JSON.stringify(samples, null, 2));

  // Write stats
  const stats = {
    totalSamples: samples.length,
    byDecision: {
      RESPOND: samples.filter((s) => s.expectedOutput.decision === "RESPOND")
        .length,
      IGNORE: samples.filter((s) => s.expectedOutput.decision === "IGNORE")
        .length,
      STOP: samples.filter((s) => s.expectedOutput.decision === "STOP").length,
    },
    byContext: Object.fromEntries(
      ALL_CONTEXTS.map((ctx) => [
        ctx,
        samples.filter((s) => s.expectedOutput.primaryContext === ctx).length,
      ]),
    ),
    byPattern: Object.fromEntries(
      [...new Set(samples.map((s) => s.metadata.pattern))].map((p) => [
        p,
        samples.filter((s) => s.metadata.pattern === p).length,
      ]),
    ),
    uniqueAgentNames: new Set(samples.map((s) => s.agentName)).size,
    avgTurnCount:
      samples.reduce((sum, s) => sum + s.metadata.turnCount, 0) /
      samples.length,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(
    join(outputDir, "stats.json"),
    JSON.stringify(stats, null, 2),
  );

  return { shouldRespondPath, contextRoutingPath, combinedPath };
}

/**
 * Export from existing Eliza trajectories to training format.
 * Converts real trajectory data into the same JSONL format.
 */
export async function exportTrajectoriesAsTraining(
  trajectories: Trajectory[],
  agentName: string,
  outputPath: string,
): Promise<number> {
  const examples: ElizaNativeTrainingExample[] = [];
  let skippedNonNativeRows = 0;
  void agentName;

  for (const trajectory of trajectories) {
    for (const call of iterateTrajectoryLlmCalls(trajectory)) {
      if (call.purpose === "should_respond") {
        const response = normalizeMessageHandlerJson(call.response ?? "");
        if (!response) {
          skippedNonNativeRows += 1;
          console.warn(
            `[dataset-generator] skipped non-native should_respond row from trajectory ${trajectory.trajectoryId} call ${call.callId ?? "unknown"}; expected native messageHandler JSON`,
          );
          continue;
        }

        const row = buildElizaNativeTrajectoryRows([trajectory]).find(
          (candidate) => candidate.callId === call.callId,
        );
        if (row) {
          examples.push({
            ...row,
            response: { ...row.response, text: response },
            metadata: {
              ...row.metadata,
              task_type: "should_respond",
              source_dataset: "runtime_trajectory_boundary",
            },
          });
        }
      }
    }
  }

  const content = examples.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(outputPath, `${content}\n`);

  if (skippedNonNativeRows > 0) {
    console.warn(
      `[dataset-generator] skipped ${skippedNonNativeRows} non-native should_respond rows while exporting ${outputPath}`,
    );
  }

  return examples.length;
}
