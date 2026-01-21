#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AgentRuntime,
  ChannelType,
  type Content,
  createMessageMemory,
  type IAgentRuntime,
  type JsonValue,
  type MessageProcessingResult,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  createOllamaModelHandlers,
  requireInferenceProvider,
} from "@elizaos/core/testing";
import { formPlugin } from "@elizaos/plugin-form";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin, { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { config } from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { character } from "../character";
import { flowOrchestratorPlugin } from "../flow-orchestrator";
import { matchingServicePlugin } from "../matching-service";
import { notificationServicePlugin } from "../notification-service";
import { soulmatesFormPlugin } from "../soulmates-form";

type ScriptDefinition = {
  id: string;
  label: string;
  userName: string;
  messages: string[];
};

type ScriptTurn = {
  role: "user" | "assistant";
  text: string;
  at: string;
  meta?: {
    mode: "stream" | "final";
    sequence: number;
  };
};

type ScriptResult = {
  id: string;
  label: string;
  userId: UUID;
  roomId: UUID;
  turns: ScriptTurn[];
};

type DemoRun = {
  startedAt: string;
  finishedAt: string;
  inference: {
    provider: string;
    model: string | null;
    temperature: number | null;
    maxTokens: number | null;
  };
  runtime: {
    agentId: UUID;
    dataDir: string;
    outputDir: string;
  };
  outputPath: string;
  scripts: ScriptResult[];
  evaluations: ScriptEvaluation[];
};

type ModelHandlerFn = (
  runtime: IAgentRuntime,
  params: Record<string, JsonValue | object>,
) => Promise<JsonValue | object>;

type ScriptEvaluation = {
  id: string;
  label: string;
  rubric: {
    empathy: number;
    clarity: number;
    safety: number;
    progression: number;
  };
  signals: {
    askedName: boolean;
    askedCity: boolean;
    mentionsPrivacy: boolean;
    mentionsConsent: boolean;
    repeatedNameAsk: boolean;
    repeatedCityAsk: boolean;
  };
  flags: string[];
};

const clampScore = (value: number): number => Math.max(0, Math.min(1, value));

const countSubstring = (text: string, token: string): number => {
  if (!token) return 0;
  let count = 0;
  let index = text.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(token, index + token.length);
  }
  return count;
};

const countPatterns = (text: string, patterns: string[]): number =>
  patterns.reduce((total, pattern) => total + countSubstring(text, pattern), 0);

const NAME_PATTERNS = [
  "what's your name",
  "what is your name",
  "what should i call you",
  "what do i call you",
  "first name",
];
const CITY_PATTERNS = [
  "what city",
  "which city",
  "city are you",
  "based in",
  "what's your city",
];
const INTENT_PATTERNS = [
  "looking for",
  "relationship intent",
  "relationship",
  "friendship",
  "business",
  "open to all",
];
const AVAILABILITY_PATTERNS = [
  "availability",
  "when are you free",
  "schedule",
  "time of day",
  "weekdays",
  "weekends",
];
const EMPATHY_PATTERNS = [
  "glad",
  "understood",
  "thanks",
  "appreciate",
  "hear you",
  "sounds",
];
const PRIVACY_PATTERNS = ["privacy", "private", "confidential"];
const CONSENT_PATTERNS = ["consent", "opt in", "opt-in", "mutual"];
const SAFETY_PATTERNS = ["safe", "safety", "block", "report", "harassment"];

const evaluateScript = (script: ScriptResult): ScriptEvaluation => {
  const assistantText = script.turns
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.text)
    .join(" ")
    .toLowerCase();

  const nameCount = countPatterns(assistantText, NAME_PATTERNS);
  const cityCount = countPatterns(assistantText, CITY_PATTERNS);
  const intentCount = countPatterns(assistantText, INTENT_PATTERNS);
  const availabilityCount = countPatterns(assistantText, AVAILABILITY_PATTERNS);
  const empathyCount = countPatterns(assistantText, EMPATHY_PATTERNS);
  const privacyCount = countPatterns(assistantText, PRIVACY_PATTERNS);
  const consentCount = countPatterns(assistantText, CONSENT_PATTERNS);
  const safetyCount = countPatterns(assistantText, SAFETY_PATTERNS);

  const signals = {
    askedName: nameCount > 0,
    askedCity: cityCount > 0,
    mentionsPrivacy: privacyCount > 0,
    mentionsConsent: consentCount > 0,
    repeatedNameAsk: nameCount > 1,
    repeatedCityAsk: cityCount > 1,
  };

  const rubric = {
    empathy: clampScore(empathyCount / 2),
    clarity: clampScore(
      (signals.askedName ? 0.25 : 0) +
        (signals.askedCity ? 0.25 : 0) +
        (intentCount > 0 ? 0.25 : 0) +
        (assistantText.length > 0 ? 0.25 : 0),
    ),
    safety: clampScore(
      (signals.mentionsPrivacy ? 0.5 : 0) +
        (signals.mentionsConsent ? 0.3 : 0) +
        (safetyCount > 0 ? 0.2 : 0),
    ),
    progression: clampScore(
      (signals.askedName ? 0.3 : 0) +
        (signals.askedCity ? 0.3 : 0) +
        (intentCount > 0 ? 0.2 : 0) +
        (availabilityCount > 0 ? 0.2 : 0),
    ),
  };

  const flags: string[] = [];
  if (!signals.askedName) flags.push("missing_name_prompt");
  if (!signals.askedCity) flags.push("missing_city_prompt");
  if (!signals.mentionsPrivacy && !signals.mentionsConsent)
    flags.push("missing_safety_messaging");
  if (signals.repeatedNameAsk) flags.push("repeated_name_prompt");
  if (signals.repeatedCityAsk) flags.push("repeated_city_prompt");

  return { id: script.id, label: script.label, rubric, signals, flags };
};

const readNumberEnv = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveModel = (provider: string): string | null => {
  if (provider === "openai") return process.env.OPENAI_MODEL ?? null;
  if (provider === "anthropic") return process.env.ANTHROPIC_MODEL ?? null;
  if (provider === "ollama") return process.env.OLLAMA_MODEL ?? null;
  return null;
};

const resolveTemperature = (provider: string): number | null => {
  if (provider === "openai")
    return readNumberEnv(process.env.OPENAI_TEMPERATURE);
  if (provider === "anthropic")
    return readNumberEnv(process.env.ANTHROPIC_TEMPERATURE);
  if (provider === "ollama")
    return readNumberEnv(process.env.OLLAMA_TEMPERATURE);
  return readNumberEnv(process.env.LLM_TEMPERATURE);
};

const resolveMaxTokens = (provider: string): number | null => {
  if (provider === "openai")
    return readNumberEnv(process.env.OPENAI_MAX_TOKENS);
  if (provider === "anthropic")
    return readNumberEnv(process.env.ANTHROPIC_MAX_TOKENS);
  if (provider === "ollama")
    return readNumberEnv(process.env.OLLAMA_MAX_TOKENS);
  return readNumberEnv(process.env.LLM_MAX_TOKENS);
};

const SCRIPTS: ScriptDefinition[] = [
  {
    id: "positive-agreeable",
    label: "Very positive + agreeable",
    userName: "Avery",
    messages: [
      "Hi Ori! I'm Avery, she/her, based in New York.",
      "I'm 29 and looking for love. I'm straight and open to a serious relationship.",
      "Ideally I'd meet someone 27-35. Non-negotiables: kindness, honesty, growth.",
      "A good week for me is yoga, reading, and time with friends. I want to build a warm, curious life.",
      "I feel alive hiking and making art. I want emotional intimacy and a steady partnership.",
      "Availability: weekdays after 6pm or weekends afternoons. Monthly cadence is good.",
    ],
  },
  {
    id: "negative-disagreeable",
    label: "Negative + disagreeable",
    userName: "Riley",
    messages: [
      "Name's Riley. I'm in Austin. He/him.",
      "I'm 32, straight, and looking for love, even if I'm skeptical.",
      "Age range 27-36. Non-negotiables: reliability and no smoking.",
      "I don't want drama. I want someone who shows up.",
      "A good week is work done early and quiet nights. I value honesty.",
      "Availability: Tuesdays after 7pm or Sundays midday.",
    ],
  },
  {
    id: "guarded-skeptical",
    label: "Guarded + skeptical",
    userName: "Jordan",
    messages: [
      "I'm Jordan. Seattle. They/them.",
      "I'm 30. Open to love or friendship, but I want to keep it minimal.",
      "Age range 28-36. Non-negotiables: respect and privacy.",
      "I want to feel safe and understood, not rushed.",
      "A good week is calm mornings, gym, and a long walk.",
      "Availability: weekdays mornings, occasional Saturday.",
    ],
  },
  {
    id: "decisive-love",
    label: "Decisive + love-focused",
    userName: "Maya",
    messages: [
      "Hi Ori, I'm Maya in Los Angeles. She/her.",
      "I'm 27, queer, looking for a committed partnership.",
      "Age range 26-33. Non-negotiables: emotional maturity and accountability.",
      "I learned from a past relationship that I need clear communication.",
      "Emotional intimacy is sharing fears without judgment.",
      "I want to build a life with travel, family, and creative work.",
      "Availability: weeknights after 6pm and Sundays. Cadence biweekly.",
    ],
  },
  {
    id: "busy-professional",
    label: "Busy + business-focused",
    userName: "Devon",
    messages: [
      "I'm Devon, he/him, based in San Francisco.",
      "I'm 35 and looking for business connections and mentorship.",
      "Ideal connection: founders or operators in fintech or AI.",
      "I can offer product strategy and fundraising experience.",
      "Short coffee or walk meetings are best. Boundaries: no late nights.",
      "Availability: Tue/Thu mornings, Fridays before noon.",
    ],
  },
  {
    id: "friendship-community",
    label: "Community + friendship",
    userName: "Sam",
    messages: [
      "Hey Ori, I'm Sam in Chicago. They/them.",
      "I'm 26 and looking for friendship and community.",
      "I love board games, cooking, and volunteering.",
      "I want friends who are consistent and kind.",
      "A good week is work, a game night, and a long run.",
      "Availability: weekends afternoons and Wednesday evenings. Cadence monthly.",
    ],
  },
];

const parseArgs = (): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const valueIndex = arg.indexOf("=");
    if (valueIndex === -1) {
      parsed[arg.slice(2)] = "true";
      continue;
    }
    const key = arg.slice(2, valueIndex);
    const value = arg.slice(valueIndex + 1);
    if (key) {
      parsed[key] = value;
    }
  }
  return parsed;
};

const ensureMessageService = (runtime: IAgentRuntime): void => {
  if (!runtime.messageService) {
    throw new Error("Runtime message service not available.");
  }
};

const runScript = async (
  runtime: IAgentRuntime,
  script: ScriptDefinition,
  worldId: UUID,
): Promise<ScriptResult> => {
  ensureMessageService(runtime);

  const userId = stringToUuid(`${runtime.agentId}-${script.id}-user`);
  const roomId = stringToUuid(`${runtime.agentId}-${script.id}-room`);
  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: script.userName,
    source: "demo-scripts",
    channelId: script.id,
    messageServerId: worldId,
    type: ChannelType.DM,
  });

  const turns: ScriptTurn[] = [];
  let assistantSequence = 0;

  const pushAssistantTurn = (text: string, mode: "stream" | "final"): void => {
    if (!text) return;
    turns.push({
      role: "assistant",
      text,
      at: new Date().toISOString(),
      meta: { mode, sequence: assistantSequence },
    });
    assistantSequence += 1;
  };

  for (const text of script.messages) {
    const content: Content = {
      text,
      source: "demo-scripts",
      channelType: ChannelType.DM,
    };

    const memory = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: userId,
      roomId,
      content,
    });

    turns.push({ role: "user", text, at: new Date().toISOString() });

    const responseParts: string[] = [];
    const result: MessageProcessingResult =
      await runtime.messageService.handleMessage(
        runtime,
        memory,
        async (response) => {
          if (typeof response?.text === "string") {
            responseParts.push(response.text);
            pushAssistantTurn(response.text, "stream");
          }
          return [];
        },
      );

    if (responseParts.length === 0) {
      const responseText =
        typeof result.responseContent?.text === "string"
          ? result.responseContent.text
          : "";
      if (responseText) {
        pushAssistantTurn(responseText, "final");
      }
    }
  }

  return { id: script.id, label: script.label, userId, roomId, turns };
};

async function main(): Promise<void> {
  config({ path: "../.env" });
  config();

  const args = parseArgs();
  const dataDir = resolve(process.cwd(), args.dataDir ?? "data/demo-runtime");
  const outputDir = resolve(process.cwd(), args.output ?? "data/demo-scripts");
  mkdirSync(outputDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const agentId = uuidv4() as UUID;
  const demoCharacter = { ...character, id: agentId };
  const inferenceProvider = await requireInferenceProvider();
  const inference = {
    provider: inferenceProvider.name,
    model: resolveModel(inferenceProvider.name),
    temperature: resolveTemperature(inferenceProvider.name),
    maxTokens: resolveMaxTokens(inferenceProvider.name),
  };

  const adapter = createDatabaseAdapter({ dataDir }, agentId);
  await adapter.init();

  const runtime = new AgentRuntime({
    character: demoCharacter,
    agentId,
    adapter,
    plugins: [
      sqlPlugin,
      openaiPlugin,
      formPlugin,
      soulmatesFormPlugin,
      flowOrchestratorPlugin,
      matchingServicePlugin,
      notificationServicePlugin,
    ],
    logLevel: "info",
  });

  if (inferenceProvider.name === "ollama") {
    const handlers = createOllamaModelHandlers();
    for (const [modelType, handler] of Object.entries(handlers)) {
      if (handler) {
        runtime.registerModel(modelType, handler as ModelHandlerFn, "ollama");
      }
    }
  }

  await runtime.initialize();

  const worldId = stringToUuid(`demo-world-${agentId}`);
  const scripts: ScriptResult[] = [];
  for (const script of SCRIPTS) {
    scripts.push(await runScript(runtime, script, worldId));
  }
  const evaluations = scripts.map((script) => evaluateScript(script));

  const finishedAt = new Date().toISOString();
  const outputPath = resolve(
    outputDir,
    `demo-run-${finishedAt.replace(/[:.]/g, "-")}.json`,
  );
  const report: DemoRun = {
    startedAt,
    finishedAt,
    inference,
    runtime: {
      agentId,
      dataDir,
      outputDir,
    },
    outputPath,
    scripts,
    evaluations,
  };

  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`Demo script run complete. Output written to ${outputPath}`);

  await runtime.stop();
}

main().catch((error: Error) => {
  console.error("Demo script run failed:", error.message);
  process.exit(1);
});
