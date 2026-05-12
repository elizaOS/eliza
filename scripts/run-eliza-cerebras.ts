#!/usr/bin/env bun
/**
 * run-eliza-cerebras — Validates the REAL v5 runtime path against Cerebras gpt-oss-120b.
 *
 * Per PLAN.md §21.4 note on G3 closure: this replaces the fetch-based
 * re-implementation in `run-cerebras.ts`. It calls `runV5MessageRuntimeStage1`
 * from the actual `@elizaos/core` runtime using a real `AgentRuntime` with
 * `plugin-openai` wired to Cerebras via `OPENAI_BASE_URL` + `CEREBRAS_API_KEY`.
 *
 * Usage:
 *   CEREBRAS_API_KEY=<key> bun run scripts/run-eliza-cerebras.ts --scenario chain-2-tools
 *   CEREBRAS_API_KEY=<key> bun run scripts/run-eliza-cerebras.ts --scenario simple-reply
 *   CEREBRAS_API_KEY=<key> bun run scripts/run-eliza-cerebras.ts --message "search for eliza"
 *
 * Env (all optional with defaults):
 *   CEREBRAS_API_KEY           Required. Cerebras API key.
 *   OPENAI_LARGE_MODEL         Override model (default: gpt-oss-120b).
 *   ELIZA_TRAJECTORY_DIR      Where to write trajectory JSON (default: ./trajectories-eliza-cerebras).
 *   ELIZA_TRAJECTORY_RECORDING  Set to 0 to disable recording.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from repo root
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  // dotenv optional
}

// ---------------------------------------------------------------------------
// Env wiring — plugin-openai reads OPENAI_BASE_URL and accepts CEREBRAS_API_KEY
// as the API key when the base URL points at cerebras.ai. Pin each OpenAI model
// tier to the same Cerebras id so message handler, planner, and evaluator route
// to the same provider/model in this validation harness.
// ---------------------------------------------------------------------------

const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY?.trim();
if (!CEREBRAS_API_KEY) {
  console.error("[run-eliza-cerebras] CEREBRAS_API_KEY is required.");
  process.exit(1);
}

const CEREBRAS_BASE_URL =
  process.env.CEREBRAS_BASE_URL?.trim() ??
  process.env.OPENAI_BASE_URL?.trim() ??
  "https://api.cerebras.ai/v1";
const CEREBRAS_MODEL =
  process.env.CEREBRAS_LARGE_MODEL?.trim() ??
  process.env.OPENAI_LARGE_MODEL?.trim() ??
  "gpt-oss-120b";
const TRAJECTORY_DIR =
  process.env.ELIZA_TRAJECTORY_DIR?.trim() ?? "./trajectories-eliza-cerebras";

process.env.OPENAI_BASE_URL = CEREBRAS_BASE_URL;
process.env.OPENAI_LARGE_MODEL = CEREBRAS_MODEL;
process.env.OPENAI_SMALL_MODEL = CEREBRAS_MODEL;
process.env.OPENAI_NANO_MODEL = CEREBRAS_MODEL;
process.env.OPENAI_RESPONSE_HANDLER_MODEL = CEREBRAS_MODEL;
process.env.OPENAI_ACTION_PLANNER_MODEL = CEREBRAS_MODEL;
process.env.ELIZA_TRAJECTORY_DIR = path.resolve(TRAJECTORY_DIR);
process.env.ELIZA_TRAJECTORY_RECORDING = "1";
process.env.ALLOW_NO_DATABASE = "true";

// ---------------------------------------------------------------------------
// Now import runtime (after env is set)
// ---------------------------------------------------------------------------

import type { Action, Memory, State, UUID } from "@elizaos/core";
import {
  AgentRuntime,
  InMemoryDatabaseAdapter,
  runV5MessageRuntimeStage1,
} from "@elizaos/core";

const { openaiPlugin } = await import("../plugins/plugin-openai/index.ts");
const { installPromptOptimizations } = await import(
  "../packages/agent/src/runtime/prompt-optimization.ts"
);

// ---------------------------------------------------------------------------
// Scenario loading
// ---------------------------------------------------------------------------

const SCENARIOS_DIR = path.join(
  REPO_ROOT,
  "research/native-tool-calling/scenarios",
);

interface Scenario {
  message: string;
  expect?: {
    noPlanner?: boolean;
    tools?: string[];
    stages?: string[];
    contexts?: string[];
    rationale?: string;
  };
}

async function loadScenario(name: string): Promise<Scenario> {
  const p = path.join(SCENARIOS_DIR, `${name}.json`);
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as Scenario;
}

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

function parseArgs(): {
  scenarioName: string | null;
  messageText: string | null;
  model: string;
  longCompactionSmoke: boolean;
} {
  const args = process.argv.slice(2);
  let scenarioName: string | null = null;
  let messageText: string | null = null;
  let model = CEREBRAS_MODEL;
  let longCompactionSmoke = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scenario" && args[i + 1]) {
      i += 1;
      scenarioName = args[i] ?? null;
    } else if (args[i] === "--message" && args[i + 1]) {
      i += 1;
      messageText = args[i] ?? null;
    } else if (args[i] === "--model" && args[i + 1]) {
      i += 1;
      model = args[i] ?? model;
    } else if (args[i] === "--long-compaction-smoke") {
      longCompactionSmoke = true;
    } else if (!args[i].startsWith("--")) {
      // positional message
      messageText = args[i] ?? null;
    }
  }

  return { scenarioName, messageText, model, longCompactionSmoke };
}

// ---------------------------------------------------------------------------
// Mock actions — real Action objects with proper parameters arrays
// ---------------------------------------------------------------------------

function makeMockAction(opts: {
  name: string;
  description: string;
  contexts?: string[];
  parameters?: Array<{
    name: string;
    description: string;
    required?: boolean;
    schema: { type: string };
  }>;
  handler: Action["handler"];
}): Action {
  return {
    name: opts.name,
    description: opts.description,
    compressedDescription: opts.description,
    contexts: opts.contexts,
    cacheStable: true,
    similes: [],
    examples: [],
    parameters: opts.parameters ?? [],
    validate: async () => true,
    handler: opts.handler,
  } satisfies Action;
}

function buildMockActions(): Action[] {
  const webSearch = makeMockAction({
    name: "WEB_SEARCH",
    description:
      "Search the public web for current information. Use for factual lookups, recent events, or anything outside the agent's prior knowledge.",
    contexts: ["web", "browser"],
    parameters: [
      {
        name: "q",
        description: "Search query string. Plain natural language is fine.",
        required: true,
        schema: { type: "string" },
        examples: ["eliza chatbot history", "weather in Paris today"],
      },
    ],
    handler: async (_rt, _msg, _state, options) => {
      const q =
        ((options.parameters as Record<string, unknown>)?.q as string) ??
        "unknown";
      printStage("TOOL", `WEB_SEARCH called with q="${q}"`);
      return {
        success: true,
        text: `Found 3 results for '${q}': elizaOS framework, ELIZA chatbot (1966), Eliza documentation.`,
        data: {
          actionName: "WEB_SEARCH",
          results: [
            { title: "elizaOS", url: "https://github.com/elizaOS/eliza" },
            {
              title: "ELIZA chatbot",
              url: "https://en.wikipedia.org/wiki/ELIZA",
            },
            { title: "Eliza docs", url: "https://elizaos.ai/docs" },
          ],
        },
      };
    },
  });

  const writeDocument = makeMockAction({
    name: "WRITE_DOCUMENT",
    description:
      "Save content as a new document in the agent's document store. Use to persist research findings, summaries, or notes for later retrieval.",
    contexts: ["documents", "web"],
    parameters: [
      {
        name: "content",
        description:
          "Full text body of the document. Markdown is fine; do not summarize or truncate.",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "title",
        description:
          "Short human-readable title used for retrieval. Defaults to a generated id when omitted.",
        required: false,
        schema: { type: "string" },
        examples: ["Eliza research summary"],
      },
    ],
    handler: async (_rt, _msg, _state, options) => {
      const params = options.parameters as Record<string, unknown>;
      const content = (params?.content as string) ?? "";
      const title = (params?.title as string) ?? "Untitled";
      const docId = `doc-${Date.now()}`;
      printStage(
        "TOOL",
        `WRITE_DOCUMENT called: title="${title}", content="${content.slice(0, 60)}..."`,
      );
      return {
        success: true,
        text: `Document '${title}' saved with id ${docId}.`,
        data: { actionName: "WRITE_DOCUMENT", documentId: docId, title },
      };
    },
  });

  const brokenAction = makeMockAction({
    name: "BROKEN_ACTION",
    description:
      "Deliberately failing action used to exercise the evaluator's failure path. Always returns success=false. Call this when the user explicitly requests it for testing.",
    contexts: ["broken_action"],
    parameters: [],
    handler: async () => {
      printStage("TOOL", "BROKEN_ACTION called — returning failure");
      return {
        success: false,
        text: "broken on purpose",
        error: "intentional failure",
        data: { actionName: "BROKEN_ACTION" },
      };
    },
  });

  // -------------------------------------------------------------------
  // Calendar mock actions — for multi-context scenario
  // -------------------------------------------------------------------

  const calendarListEvents = makeMockAction({
    name: "CALENDAR_LIST_EVENTS",
    description:
      "List the user's calendar events in a given time window. Use to check availability before scheduling, or to find existing meetings to summarize.",
    contexts: ["calendar"],
    parameters: [
      {
        name: "range",
        description:
          "Time window for the listing — natural-language phrases like 'today', 'this week', or 'next 7 days' are accepted.",
        required: false,
        schema: { type: "string" },
        examples: ["today", "this week", "next 7 days"],
      },
    ],
    handler: async (_rt, _msg, _state, options) => {
      const range =
        ((options.parameters as Record<string, unknown>)?.range as string) ??
        "today";
      printStage("TOOL", `CALENDAR_LIST_EVENTS called with range="${range}"`);
      return {
        success: true,
        text: `Found 2 events for '${range}': Team standup at 9am, 1:1 with Bob at 3pm.`,
        data: {
          actionName: "CALENDAR_LIST_EVENTS",
          events: [
            { id: "ev1", title: "Team standup", time: "09:00" },
            { id: "ev2", title: "1:1 with Bob", time: "15:00" },
          ],
        },
      };
    },
  });

  const calendarCreateEvent = makeMockAction({
    name: "CALENDAR_CREATE_EVENT",
    description:
      "Create a new calendar event for the user. Use for scheduling meetings, reminders, or any time-bound commitment that should appear on the calendar.",
    contexts: ["calendar"],
    parameters: [
      {
        name: "title",
        description: "Short human-readable event title shown on the calendar.",
        required: true,
        schema: { type: "string" },
        examples: ["Team standup", "1:1 with Bob"],
      },
      {
        name: "time",
        description:
          "Event start time. ISO-8601 (e.g. 2025-06-15T15:00:00) or natural language ('tomorrow at 9am') are both accepted.",
        required: true,
        schema: { type: "string" },
        examples: ["2025-06-15T15:00:00", "tomorrow at 9am"],
      },
      {
        name: "attendees",
        description:
          "Comma-separated list of attendee email addresses. Leave empty for personal events.",
        required: false,
        schema: { type: "string" },
        examples: ["alice@example.com,bob@example.com"],
      },
    ],
    handler: async (_rt, _msg, _state, options) => {
      const params = options.parameters as Record<string, unknown>;
      const title = (params?.title as string) ?? "Untitled meeting";
      const time = (params?.time as string) ?? "TBD";
      const attendees = (params?.attendees as string) ?? "";
      printStage(
        "TOOL",
        `CALENDAR_CREATE_EVENT called: title="${title}", time="${time}", attendees="${attendees}"`,
      );
      return {
        success: true,
        text: `Meeting '${title}' created at ${time}${attendees ? ` with ${attendees}` : ""}.`,
        data: {
          actionName: "CALENDAR_CREATE_EVENT",
          eventId: `ev-${Date.now()}`,
          title,
          time,
          attendees,
        },
      };
    },
  });

  // -------------------------------------------------------------------
  // Email mock actions — for multi-context scenario
  // -------------------------------------------------------------------

  const emailDraft = makeMockAction({
    name: "EMAIL_DRAFT",
    description:
      "Create an email draft for the user to review before sending. Use when the user asks to compose, draft, or prepare an email — never to send mail directly.",
    contexts: ["email"],
    parameters: [
      {
        name: "to",
        description: "Recipient email address (single address).",
        required: true,
        schema: { type: "string" },
        examples: ["alice@example.com"],
      },
      {
        name: "subject",
        description: "Email subject line. Keep concise; one short phrase.",
        required: true,
        schema: { type: "string" },
        examples: ["Meeting agenda"],
      },
      {
        name: "body",
        description:
          "Full email body. Plain text or markdown. Include greeting, content, and signature when relevant.",
        required: true,
        schema: { type: "string" },
      },
    ],
    handler: async (_rt, _msg, _state, options) => {
      const params = options.parameters as Record<string, unknown>;
      const to = (params?.to as string) ?? "unknown@example.com";
      const subject = (params?.subject as string) ?? "(no subject)";
      printStage(
        "TOOL",
        `EMAIL_DRAFT called: to="${to}", subject="${subject}"`,
      );
      return {
        success: true,
        text: `Email draft created: to=${to}, subject="${subject}".`,
        data: {
          actionName: "EMAIL_DRAFT",
          draftId: `draft-${Date.now()}`,
          to,
          subject,
        },
      };
    },
  });

  const emailSend = makeMockAction({
    name: "EMAIL_SEND",
    description:
      "Send an email message immediately on the user's behalf. Use only when the user has explicitly authorized sending; for compose-only requests prefer EMAIL_DRAFT.",
    contexts: ["email"],
    parameters: [
      {
        name: "to",
        description: "Recipient email address (single address).",
        required: true,
        schema: { type: "string" },
        examples: ["alice@example.com"],
      },
      {
        name: "subject",
        description: "Email subject line. Keep concise; one short phrase.",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "body",
        description:
          "Full email body. Plain text or markdown. Include greeting, content, and signature when relevant.",
        required: true,
        schema: { type: "string" },
      },
    ],
    handler: async (_rt, _msg, _state, options) => {
      const params = options.parameters as Record<string, unknown>;
      const to = (params?.to as string) ?? "unknown@example.com";
      const subject = (params?.subject as string) ?? "(no subject)";
      printStage("TOOL", `EMAIL_SEND called: to="${to}", subject="${subject}"`);
      return {
        success: true,
        text: `Email sent to ${to} with subject "${subject}".`,
        data: {
          actionName: "EMAIL_SEND",
          messageId: `msg-${Date.now()}`,
          to,
          subject,
        },
      };
    },
  });

  // -------------------------------------------------------------------
  // RESEARCH — umbrella action with subActions for sub-planner scenario.
  // The real runtime triggers runSubPlanner automatically when it sees
  // `action.subActions.length > 0`, so this handler never runs.
  // Scoped to its own `research_workflow` context so it does not bleed
  // into the chain-2-tools scenario, which expects flat WEB_SEARCH +
  // WRITE_DOCUMENT calls under the `web`/`documents` contexts.
  // -------------------------------------------------------------------

  const research = {
    ...makeMockAction({
      name: "RESEARCH",
      description:
        "Research a topic on the web and save the findings as a document.",
      contexts: ["research_workflow"],
      parameters: [
        {
          name: "query",
          description: "Topic to research",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "title",
          description: "Title for the saved document",
          required: false,
          schema: { type: "string" },
        },
      ],
      handler: async () => {
        printStage(
          "TOOL",
          "RESEARCH handler called — should not be invoked directly; sub-planner should have dispatched",
        );
        return {
          success: false,
          text: "Should not be called directly — sub-planner dispatch expected.",
          error: "direct-call-not-expected",
          data: { actionName: "RESEARCH" },
        };
      },
    }),
    subActions: ["WEB_SEARCH", "WRITE_DOCUMENT"],
  } satisfies ReturnType<typeof makeMockAction>;

  return [
    webSearch,
    writeDocument,
    brokenAction,
    calendarListEvents,
    calendarCreateEvent,
    emailDraft,
    emailSend,
    research,
  ];
}

// ---------------------------------------------------------------------------
// Pretty-printing helpers
// ---------------------------------------------------------------------------

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined;
}

function buildPromptOptimizationConfig(model: string) {
  const forcedContextWindow = readPositiveIntEnv(
    "ELIZA_CEREBRAS_CONTEXT_WINDOW_TOKENS",
  );
  const forcedMaxTokens =
    readPositiveIntEnv("ELIZA_CEREBRAS_MAX_OUTPUT_TOKENS") ?? 1024;
  if (!forcedContextWindow) return undefined;
  return {
    agents: {
      defaults: {
        contextTokens: forcedContextWindow,
        model: {
          primary: model,
          large: model,
          small: model,
        },
      },
    },
    models: {
      providers: {
        cerebras: {
          baseUrl: CEREBRAS_BASE_URL,
          apiKey: CEREBRAS_API_KEY,
          models: [
            {
              id: model,
              name: model,
              reasoning: true,
              input: ["text"],
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              contextWindow: forcedContextWindow,
              maxTokens: forcedMaxTokens,
            },
          ],
        },
      },
      large: model,
      small: model,
    },
  };
}

function printBanner(text: string): void {
  const bar = "─".repeat(60);
  console.log(`\n${BOLD}${bar}${RESET}`);
  console.log(`${BOLD} ${text}${RESET}`);
  console.log(`${BOLD}${bar}${RESET}\n`);
}

function printStage(kind: string, detail: string): void {
  const color =
    kind === "TOOL"
      ? YELLOW
      : kind === "ERROR"
        ? RED
        : kind === "DONE"
          ? GREEN
          : CYAN;
  console.log(`${color}[${kind}]${RESET} ${detail}`);
}

function collectPromptOptimizationRecords(value: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const metadata = record.providerMetadata;
    if (
      metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      "promptOptimization" in metadata
    ) {
      out.push((metadata as Record<string, unknown>).promptOptimization);
    }
    const providerOptions = record.providerOptions;
    if (
      providerOptions &&
      typeof providerOptions === "object" &&
      !Array.isArray(providerOptions)
    ) {
      const eliza = (providerOptions as Record<string, unknown>).eliza;
      if (eliza && typeof eliza === "object" && !Array.isArray(eliza)) {
        const promptOptimization = (eliza as Record<string, unknown>)
          .promptOptimization;
        if (promptOptimization) out.push(promptOptimization);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return out;
}

function stringifyModelResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    const responseContent = record.responseContent;
    if (
      responseContent &&
      typeof responseContent === "object" &&
      !Array.isArray(responseContent) &&
      typeof (responseContent as Record<string, unknown>).text === "string"
    ) {
      return String((responseContent as Record<string, unknown>).text);
    }
    if (typeof record.response === "string") return record.response;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function runLongCompactionSmoke(
  runtime: InstanceType<typeof AgentRuntime>,
  model: string,
): Promise<void> {
  printBanner("Long Message-Array Compaction Smoke");
  const payload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a concise recall assistant. Answer with the requested value only.",
      },
      ...Array.from({ length: 36 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content:
          i === 2
            ? `Important: the anchor code is ANCHOR-7781. ${"context ".repeat(60)}`
            : `Historical turn ${i}. ${"filler context ".repeat(60)}`,
      })),
      {
        role: "user",
        content: "What is the anchor code?",
      },
    ],
    maxTokens: 128,
    providerOptions: {},
  };

  const result = await runtime.useModel("RESPONSE_HANDLER", payload);
  const resultText = stringifyModelResult(result);
  const providerOptions = payload.providerOptions as
    | { eliza?: { promptOptimization?: Record<string, unknown> } }
    | undefined;
  const telemetry = providerOptions?.eliza?.promptOptimization;
  console.log(`${GREEN}[LONG-SMOKE]${RESET} response: ${resultText}`);
  console.log(
    `${GREEN}[LONG-SMOKE]${RESET} anchorRecall: ${
      resultText.includes("ANCHOR-7781") ? "PASS" : "CHECK"
    }`,
  );
  if (telemetry) {
    const compaction = telemetry.conversationCompaction as
      | Record<string, unknown>
      | undefined;
    console.log(
      `${GREEN}[LONG-SMOKE]${RESET} promptOptimization: original=${String(
        telemetry.originalPromptTokens,
      )} final=${String(telemetry.finalPromptTokens)} budget=${String(
        telemetry.budgetTokens,
      )}`,
    );
    if (compaction) {
      console.log(
        `${GREEN}[LONG-SMOKE]${RESET} conversationCompaction: strategy=${String(
          compaction.strategy,
        )} didCompact=${String(compaction.didCompact)} original=${String(
          compaction.originalTokens,
        )} compacted=${String(compaction.compactedTokens)}`,
      );
    }
  } else {
    console.log(
      `${YELLOW}[LONG-SMOKE]${RESET} No promptOptimization telemetry on payload`,
    );
  }
}

// ---------------------------------------------------------------------------
// Build and initialize the real AgentRuntime
// ---------------------------------------------------------------------------

async function buildRuntime(
  model: string,
): Promise<InstanceType<typeof AgentRuntime>> {
  process.env.OPENAI_LARGE_MODEL = model;
  process.env.OPENAI_SMALL_MODEL = model;
  process.env.OPENAI_NANO_MODEL = model;
  process.env.OPENAI_RESPONSE_HANDLER_MODEL = model;
  process.env.OPENAI_ACTION_PLANNER_MODEL = model;

  const runtime = new AgentRuntime({
    character: {
      name: "ElizaCerebrasTest",
      bio: ["A test agent for Cerebras validation"],
      system:
        "You are a concise, helpful assistant. When you use tools, use them exactly once per task. Do not loop unnecessarily.",
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      plugins: [],
      secrets: {
        CEREBRAS_API_KEY,
        OPENAI_BASE_URL: CEREBRAS_BASE_URL,
        OPENAI_LARGE_MODEL: model,
        OPENAI_SMALL_MODEL: model,
        OPENAI_NANO_MODEL: model,
        OPENAI_RESPONSE_HANDLER_MODEL: model,
        OPENAI_ACTION_PLANNER_MODEL: model,
      },
    },
    adapter: new InMemoryDatabaseAdapter(),
    plugins: [
      openaiPlugin,
      ...buildMockActions().map((a) => ({
        name: `action-${a.name}`,
        description: `Mock action: ${a.name}`,
        actions: [a],
      })),
    ],
    settings: {
      CEREBRAS_API_KEY,
      OPENAI_BASE_URL: CEREBRAS_BASE_URL,
      OPENAI_LARGE_MODEL: model,
      OPENAI_SMALL_MODEL: model,
      OPENAI_NANO_MODEL: model,
      OPENAI_RESPONSE_HANDLER_MODEL: model,
      OPENAI_ACTION_PLANNER_MODEL: model,
      ALLOW_NO_DATABASE: "true",
    },
    logLevel: "warn",
    disableBasicCapabilities: false,
  });

  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  installPromptOptimizations(runtime, buildPromptOptimizationConfig(model));
  runtime.contexts.tryRegister({
    id: "broken_action",
    label: "Broken Action",
    description:
      "Testing-only context that exposes BROKEN_ACTION for failure-path validation. Select only when the user explicitly asks to run BROKEN_ACTION.",
    sensitivity: "public",
    cacheStable: true,
    cacheScope: "global",
    roleGate: { minRole: "USER" },
  });
  runtime.contexts.tryRegister({
    id: "research_workflow",
    label: "Research Workflow",
    description:
      "Bundled umbrella research workflows that combine web lookup with saving findings as a document, when the user asks for a titled or labeled research artifact. Distinct from raw web search.",
    sensitivity: "public",
    cacheStable: true,
    cacheScope: "global",
    roleGate: { minRole: "USER" },
  });
  return runtime;
}

// ---------------------------------------------------------------------------
// Trajectory reader
// ---------------------------------------------------------------------------

async function readTrajectoryFromDir(
  dir: string,
  agentId: string,
  startMs: number,
): Promise<unknown | null> {
  const agentDir = path.join(dir, agentId);
  try {
    const entries = await fs.readdir(agentDir);
    const candidates: Array<{ fname: string; mtimeMs: number }> = [];
    for (const fname of entries.filter((e) => e.endsWith(".json"))) {
      const fpath = path.join(agentDir, fname);
      const stat = await fs.stat(fpath);
      if (stat.mtimeMs >= startMs - 5000) {
        candidates.push({ fname, mtimeMs: stat.mtimeMs });
      }
    }
    const newest = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (newest) {
      const raw = await fs.readFile(path.join(agentDir, newest.fname), "utf8");
      return JSON.parse(raw);
    }
  } catch {
    // directory may not exist yet
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run a single scenario
// ---------------------------------------------------------------------------

async function runScenario(
  scenario: Scenario,
  scenarioLabel: string,
): Promise<void> {
  printBanner(`Scenario: ${scenarioLabel}`);
  console.log(`${DIM}Message: "${scenario.message}"${RESET}`);
  if (scenario.expect?.rationale) {
    console.log(`${DIM}Rationale: ${scenario.expect.rationale}${RESET}\n`);
  }

  const startMs = Date.now();

  const { model, longCompactionSmoke } = parseArgs();
  console.log(`${CYAN}[SETUP]${RESET} Using model: ${model}`);
  console.log(
    `${CYAN}[SETUP]${RESET} Trajectory dir: ${path.resolve(TRAJECTORY_DIR)}`,
  );
  console.log(
    `${CYAN}[SETUP]${RESET} Conversation compactor: ${process.env.ELIZA_CONVERSATION_COMPACTOR ?? "(off)"}`,
  );
  if (process.env.ELIZA_CEREBRAS_CONTEXT_WINDOW_TOKENS) {
    console.log(
      `${CYAN}[SETUP]${RESET} Forced context window: ${process.env.ELIZA_CEREBRAS_CONTEXT_WINDOW_TOKENS} tokens`,
    );
  }

  const runtime = await buildRuntime(model);
  console.log(
    `${GREEN}[SETUP]${RESET} AgentRuntime initialized (agentId: ${runtime.agentId})`,
  );

  // Send as the agent itself so resolveStage1SenderRole returns "OWNER" and
  // every gated context (calendar/email/finance/etc) becomes available to the
  // messageHandler. Without this the harness's anonymous sender is "USER" and
  // ADMIN/OWNER-gated contexts are silently filtered out before the prompt is
  // built — which is correct production behavior, but the wrong condition for
  // tests that exercise the full registry.
  const message: Memory = {
    id: crypto.randomUUID() as UUID,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: crypto.randomUUID() as UUID,
    content: { text: scenario.message, source: "run-eliza-cerebras" },
    createdAt: Date.now(),
  };

  // The state object's `availableContexts` is a legacy hint. Stage 1 reads
  // the live `runtime.contexts` registry — which after `runtime.initialize()`
  // contains all 28 first-party contexts plus any plugin-registered contexts —
  // so we leave it empty here.
  const state: State = {
    values: {},
    data: {},
    text: "No prior conversation.",
  };

  const responseId = crypto.randomUUID() as UUID;

  console.log(`\n${CYAN}[RUN]${RESET} Calling runV5MessageRuntimeStage1 ...\n`);

  let result: Awaited<ReturnType<typeof runV5MessageRuntimeStage1>> | undefined;
  let err: Error | null = null;
  try {
    result = await runV5MessageRuntimeStage1({
      runtime,
      message,
      state,
      responseId,
    });
  } catch (e) {
    err = e as Error;
    printStage("ERROR", `runV5MessageRuntimeStage1 threw: ${err.message}`);
    console.error(err);
  }

  const endMs = Date.now();
  const durationMs = endMs - startMs;

  // Read trajectory
  const trajectory = await readTrajectoryFromDir(
    path.resolve(TRAJECTORY_DIR),
    String(runtime.agentId),
    startMs,
  );

  // Print result summary
  console.log(`\n${GREEN}[RESULT]${RESET} kind: ${result?.kind ?? "error"}`);

  if (result?.kind === "planned_reply" || result?.kind === "direct_reply") {
    const text = result.result?.responseContent?.text;
    console.log(`${GREEN}[RESPONSE]${RESET} "${text}"`);
  } else if (result?.kind === "terminal") {
    console.log(`${YELLOW}[TERMINAL]${RESET} action: ${result.action}`);
  }

  console.log(`\n${CYAN}[TIMING]${RESET} Total: ${durationMs}ms`);

  // Print trajectory summary
  if (trajectory) {
    const t = trajectory as {
      trajectoryId: string;
      status: string;
      stages?: Array<{
        kind: string;
        model?: {
          usage?: Record<string, unknown>;
          toolCalls?: Array<{ name?: string }>;
        };
        tool?: { name?: string; success?: boolean };
        evaluation?: { decision?: string; messageToUser?: string };
      }>;
      metrics?: Record<string, unknown>;
      contextObject?: { selectedContexts?: string[] };
    };
    console.log(`\n${GREEN}[TRAJECTORY]${RESET} id: ${t.trajectoryId}`);
    console.log(`  status: ${t.status}`);
    console.log(`  stages: ${t.stages?.map((s) => s.kind).join(" → ")}`);
    if (t.metrics) {
      console.log(`  metrics:`);
      for (const [k, v] of Object.entries(t.metrics)) {
        console.log(`    ${k}: ${v}`);
      }
    }

    const promptOptimizationRecords =
      collectPromptOptimizationRecords(trajectory);
    if (promptOptimizationRecords.length > 0) {
      console.log(
        `  promptOptimization records: ${promptOptimizationRecords.length}`,
      );
      const latest = promptOptimizationRecords.at(-1) as
        | Record<string, unknown>
        | undefined;
      const compaction = latest?.conversationCompaction as
        | Record<string, unknown>
        | undefined;
      if (compaction) {
        console.log(
          `    conversationCompaction: strategy=${String(compaction.strategy)} didCompact=${String(compaction.didCompact)} original=${String(compaction.originalTokens)} compacted=${String(compaction.compactedTokens)}`,
        );
      }
    }

    // Token usage across stages
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCacheRead = 0;
    for (const stage of t.stages ?? []) {
      const u = stage.model?.usage as Record<string, number> | undefined;
      if (u) {
        totalPrompt += u.promptTokens ?? 0;
        totalCompletion += u.completionTokens ?? 0;
        totalCacheRead += u.cacheReadInputTokens ?? 0;
      }
    }
    const totalTokens = totalPrompt + totalCompletion;
    console.log(`\n  Token totals:`);
    console.log(`    prompt: ${totalPrompt}`);
    console.log(`    completion: ${totalCompletion}`);
    console.log(`    total: ${totalTokens}`);
    console.log(`    cacheRead: ${totalCacheRead}`);
    if (totalPrompt > 0) {
      console.log(
        `    cacheRate: ${((totalCacheRead / totalPrompt) * 100).toFixed(1)}%`,
      );
    }

    // Rough cost (Cerebras pricing: ~$0.60/1M input, ~$0.60/1M output)
    const COST_PER_M = 0.6;
    const costUsd = (totalTokens / 1_000_000) * COST_PER_M;
    console.log(`    estimatedCost: $${costUsd.toFixed(5)}`);

    // Validation
    console.log(`\n${BOLD}[VALIDATION]${RESET}`);
    const stageKinds = t.stages?.map((s) => s.kind) ?? [];

    if (scenario.expect?.noPlanner) {
      const hasPlanner = stageKinds.includes("planner");
      const status = !hasPlanner ? `${GREEN}PASS` : `${RED}FAIL`;
      console.log(
        `  noPlanner: ${status} (stages: ${stageKinds.join(",")})${RESET}`,
      );
    }

    if (scenario.expect?.stages) {
      const expectedStages = scenario.expect.stages;
      const allPresent = expectedStages.every((k) => stageKinds.includes(k));
      const status = allPresent ? `${GREEN}PASS` : `${YELLOW}PARTIAL`;
      console.log(
        `  expected stages [${expectedStages.join(",")}]: ${status} (got: ${stageKinds.join(",")})${RESET}`,
      );
    }

    // Tool calls observed in the trajectory (from tool stages)
    const toolNames = (t.stages ?? [])
      .filter((s) => s.kind === "tool" && s.tool?.name)
      .map((s) => s.tool?.name as string);
    if (toolNames.length > 0) {
      console.log(`  tools called: ${toolNames.join(", ")}`);
    }
    if (scenario.expect?.tools) {
      const expectedTools = scenario.expect.tools;
      const allCalled = expectedTools.every((tool) => toolNames.includes(tool));
      const status = allCalled ? `${GREEN}PASS` : `${YELLOW}PARTIAL`;
      console.log(
        `  expected tools [${expectedTools.join(",")}]: ${status}${RESET}`,
      );
    }

    // Selected contexts from messageHandler stage (parsed from the recorded
    // message_handler event in the contextObject, or from the planner context).
    const selectedContexts =
      t.contextObject?.selectedContexts ??
      (() => {
        // Best-effort: look at the message_handler context event in any stage's
        // recorded contextObject.
        const stagesWithContext = (t.stages ?? []) as Array<{
          contextObject?: {
            events?: Array<{
              type?: string;
              metadata?: { plan?: { contexts?: string[] } };
            }>;
          };
        }>;
        for (const stage of stagesWithContext) {
          const events = stage.contextObject?.events ?? [];
          for (const ev of events) {
            if (ev.type === "message_handler" && ev.metadata?.plan?.contexts) {
              return ev.metadata.plan.contexts;
            }
          }
        }
        return undefined;
      })();
    if (selectedContexts) {
      console.log(`  selected contexts: [${selectedContexts.join(",")}]`);
    }
    if (scenario.expect?.contexts && selectedContexts) {
      const expectedContexts = scenario.expect.contexts;
      const allPresent = expectedContexts.every((ctx) =>
        selectedContexts.includes(ctx),
      );
      const status = allPresent ? `${GREEN}PASS` : `${YELLOW}PARTIAL`;
      console.log(
        `  expected contexts [${expectedContexts.join(",")}]: ${status}${RESET}`,
      );
    }

    const trajectoryFile = path.join(
      path.resolve(TRAJECTORY_DIR),
      String(runtime.agentId),
      `${t.trajectoryId}.json`,
    );
    console.log(`\n${GREEN}[FILE]${RESET} ${trajectoryFile}`);
  } else if (!err) {
    console.log(
      `\n${YELLOW}[TRAJECTORY]${RESET} No trajectory file found (recording may be off)`,
    );
  }

  if (err) {
    printStage("ERROR", `Run failed: ${err.message}`);
  } else {
    printStage(
      "DONE",
      `Scenario '${scenarioLabel}' completed in ${durationMs}ms`,
    );
  }

  if (longCompactionSmoke) {
    try {
      await runLongCompactionSmoke(runtime, model);
    } catch (smokeError) {
      printStage(
        "ERROR",
        `Long compaction smoke failed: ${(smokeError as Error).message}`,
      );
    }
  }

  try {
    await runtime.stop();
    await runtime.close();
  } catch (teardownError) {
    printStage(
      "ERROR",
      `Runtime teardown warning: ${(teardownError as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  printBanner("run-eliza-cerebras — Real Runtime v5 Validation");
  console.log(`Model:  ${CEREBRAS_MODEL}`);
  console.log(`Endpoint: ${CEREBRAS_BASE_URL}`);
  console.log(`Trajectory dir: ${path.resolve(TRAJECTORY_DIR)}\n`);

  const { scenarioName, messageText } = parseArgs();

  if (scenarioName) {
    let scenario: Scenario;
    try {
      scenario = await loadScenario(scenarioName);
    } catch (e) {
      console.error(
        `[run-eliza-cerebras] Cannot load scenario '${scenarioName}': ${(e as Error).message}`,
      );
      process.exit(1);
    }
    await runScenario(scenario, scenarioName);
  } else if (messageText) {
    const scenario: Scenario = { message: messageText };
    await runScenario(scenario, "inline-message");
  } else {
    // Default: run all six reference scenarios in one process.
    const allScenarios = [
      "simple-reply",
      "single-tool",
      "chain-2-tools",
      "chain-with-failure",
      "multi-context",
      "sub-planner",
    ];
    console.log(`Running all ${allScenarios.length} reference scenarios.\n`);

    for (const name of allScenarios) {
      try {
        const scenario = await loadScenario(name);
        await runScenario(scenario, name);
      } catch (e) {
        console.error(
          `[run-eliza-cerebras] Scenario '${name}' threw: ${(e as Error).message}`,
        );
      }
      console.log("\n\n");
    }
  }
}

main().catch((e: Error) => {
  console.error("[run-eliza-cerebras] Fatal:", e.message);
  console.error(e.stack);
  process.exit(1);
});
