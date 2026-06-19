#!/usr/bin/env bun
/**
 * Conversation-compaction drift harness.
 *
 * Drives a synthetic multi-turn conversation with planted facts, forces a
 * selected compaction strategy on a fixed cadence, and emits reproducible
 * JSONL events consumed by packages/benchmarks/context-bench.
 */

import {
  compactors,
  findSafeCompactionBoundary,
} from "../../packages/agent/src/runtime/conversation-compactor.ts";
import {
  approxCountTokens,
  type CompactionArtifact,
  type CompactorMessage,
  type CompactorModelCall,
  type CompactorTranscript,
  countTranscriptTokens,
} from "../../packages/agent/src/runtime/conversation-compactor.types.ts";

const KNOWN_STRATEGIES = [
  "none",
  "prompt-stripping",
  "naive-summary",
  "structured-state",
  "hierarchical-summary",
  "hybrid-ledger",
] as const;

type StrategyName = (typeof KNOWN_STRATEGIES)[number];

type ReasoningEffort = "low" | "medium" | "high";

type Args = {
  strategy: StrategyName;
  turns: number;
  compactEvery: number;
  plantFacts: number;
  seed: number;
  output?: string;
  dryRun: boolean;
  agentModel: string;
  judgeModel: string;
  compactorModel: string;
  agentReasoningEffort: ReasoningEffort;
  judgeReasoningEffort: ReasoningEffort;
  compactorReasoningEffort: ReasoningEffort;
  probeMaxTokens: number;
  realisticSystemPrompt: boolean;
  withToolCalls: boolean;
};

type Fact = {
  id: string;
  kind: string;
  expected: string;
  question: string;
  plantedTurn: number;
};

type ProbeEvent = {
  event: "probe";
  atTurn: number;
  factId: string;
  plantedTurn: number;
  kind: string;
  expected: string;
  actual: string;
  correct: boolean;
  judgeReasoning: string;
  phase: "post-compact" | "final";
};

const FACT_KINDS = [
  "aws_account",
  "person_name",
  "address",
  "code",
  "book_title",
  "project_codename",
  "isbn",
  "date_iso",
  "birthday",
  "flight_number",
  "uuid",
  "zipcode",
] as const;

function usage(): string {
  return [
    "usage: bun run scripts/benchmark/drift-harness.ts --strategy <name> [options]",
    "",
    `strategies: ${KNOWN_STRATEGIES.join(", ")}`,
    "",
    "options:",
    "  --turns <n>                         default 50",
    "  --compact-every <n>                 default 10",
    "  --plant-facts <n>                   default 5",
    "  --seed <n>                          default 1337",
    "  --output <path>                     write JSONL to path",
    "  --dry-run                          deterministic local model; no API calls",
    "  --agent-model <id>                  default env AGENT_MODEL or gpt-oss-120b",
    "  --judge-model <id>                  default env JUDGE_MODEL or agent model",
    "  --compactor-model <id>              default env COMPACTOR_MODEL or agent model",
    "  --agent-reasoning-effort <level>     low | medium | high, default medium",
    "  --judge-reasoning-effort <level>     low | medium | high, default medium",
    "  --compactor-reasoning-effort <level> low | medium | high, default low",
    "  --probe-max-tokens <n>              default 600",
    "  --realistic-system-prompt           use a larger Eliza-style system prompt",
    "  --with-tool-calls                   add synthetic tool-call/result probes",
  ].join("\n");
}

function parseReasoningEffort(value: string): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`invalid reasoning effort ${value}`);
}

function readFlag(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${argv[index]}`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const agentModel = process.env.AGENT_MODEL ?? "gpt-oss-120b";
  const args: Args = {
    strategy: "none",
    turns: 50,
    compactEvery: 10,
    plantFacts: 5,
    seed: 1337,
    dryRun: false,
    agentModel,
    judgeModel: process.env.JUDGE_MODEL ?? agentModel,
    compactorModel: process.env.COMPACTOR_MODEL ?? agentModel,
    agentReasoningEffort: "medium",
    judgeReasoningEffort: "medium",
    compactorReasoningEffort: "low",
    probeMaxTokens: 600,
    realisticSystemPrompt: false,
    withToolCalls: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      case "--strategy": {
        const value = readFlag(argv, i);
        if (!KNOWN_STRATEGIES.includes(value as StrategyName)) {
          throw new Error(
            `unknown strategy ${value}; expected ${KNOWN_STRATEGIES.join(", ")}`,
          );
        }
        args.strategy = value as StrategyName;
        i++;
        break;
      }
      case "--turns":
        args.turns = Number(readFlag(argv, i));
        i++;
        break;
      case "--compact-every":
        args.compactEvery = Number(readFlag(argv, i));
        i++;
        break;
      case "--plant-facts":
        args.plantFacts = Number(readFlag(argv, i));
        i++;
        break;
      case "--seed":
        args.seed = Number(readFlag(argv, i));
        i++;
        break;
      case "--output":
        args.output = readFlag(argv, i);
        i++;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--agent-model":
        args.agentModel = readFlag(argv, i);
        i++;
        break;
      case "--judge-model":
        args.judgeModel = readFlag(argv, i);
        i++;
        break;
      case "--compactor-model":
        args.compactorModel = readFlag(argv, i);
        i++;
        break;
      case "--agent-reasoning-effort":
        args.agentReasoningEffort = parseReasoningEffort(readFlag(argv, i));
        i++;
        break;
      case "--judge-reasoning-effort":
        args.judgeReasoningEffort = parseReasoningEffort(readFlag(argv, i));
        i++;
        break;
      case "--compactor-reasoning-effort":
        args.compactorReasoningEffort = parseReasoningEffort(readFlag(argv, i));
        i++;
        break;
      case "--probe-max-tokens":
        args.probeMaxTokens = Number(readFlag(argv, i));
        i++;
        break;
      case "--realistic-system-prompt":
        args.realisticSystemPrompt = true;
        break;
      case "--with-tool-calls":
        args.withToolCalls = true;
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }

  if (!Number.isInteger(args.turns) || args.turns < 1) {
    throw new Error("--turns must be a positive integer");
  }
  if (!Number.isInteger(args.compactEvery) || args.compactEvery < 1) {
    throw new Error("--compact-every must be a positive integer");
  }
  if (!Number.isInteger(args.plantFacts) || args.plantFacts < 0) {
    throw new Error("--plant-facts must be a non-negative integer");
  }
  if (!Number.isInteger(args.seed)) {
    throw new Error("--seed must be an integer");
  }
  if (!Number.isInteger(args.probeMaxTokens) || args.probeMaxTokens < 1) {
    throw new Error("--probe-max-tokens must be a positive integer");
  }

  return args;
}

function seededInt(seed: number, index: number, modulo: number): number {
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) % modulo;
}

function padded(seed: number, index: number, digits: number): string {
  const max = 10 ** Math.min(digits, 12);
  const n = seededInt(seed, index, max);
  return String(n).padStart(digits, "0").slice(0, digits);
}

function uuidFor(seed: number, index: number): string {
  const parts = [8, 4, 4, 4, 12].map((digits, part) =>
    padded(seed + part * 101, index, digits).replace(/[0-9]/g, (d) =>
      Number(d).toString(16),
    ),
  );
  return parts.join("-");
}

function valueForKind(kind: string, seed: number, index: number): string {
  const names = ["Mira Valen", "Talia Rune", "Niko Ardent", "Sana Holt"];
  const books = [
    "The Glass Atlas",
    "Lanterns Under Ice",
    "The Quiet Relay",
    "Signal Garden",
  ];
  const codenames = [
    "EMBER-VAULT",
    "POLARIS-NINE",
    "CITRINE-LAB",
    "ORBIT-MINT",
  ];
  switch (kind) {
    case "aws_account":
      return padded(seed, index, 12);
    case "person_name":
      return names[seededInt(seed, index, names.length)];
    case "address":
      return `${100 + seededInt(seed, index, 899)} Meridian Ave, Unit ${1 + seededInt(seed, index + 1, 40)}`;
    case "code":
      return `CTX-${padded(seed, index, 6)}`;
    case "book_title":
      return books[seededInt(seed, index, books.length)];
    case "project_codename":
      return codenames[seededInt(seed, index, codenames.length)];
    case "isbn":
      return `978-1-${padded(seed, index, 3)}-${padded(seed, index + 1, 5)}-${seededInt(seed, index + 2, 10)}`;
    case "date_iso":
      return `2026-${String(1 + seededInt(seed, index, 12)).padStart(2, "0")}-${String(1 + seededInt(seed, index + 1, 28)).padStart(2, "0")}`;
    case "birthday":
      return `${String(1 + seededInt(seed, index, 12)).padStart(2, "0")}/${String(1 + seededInt(seed, index + 1, 28)).padStart(2, "0")}/199${seededInt(seed, index + 2, 10)}`;
    case "flight_number":
      return `EL${padded(seed, index, 4)}`;
    case "uuid":
      return uuidFor(seed, index);
    case "zipcode":
      return padded(seed, index, 5);
    default:
      return `VALUE-${padded(seed, index, 6)}`;
  }
}

function questionFor(kind: string, id: string): string {
  switch (kind) {
    case "aws_account":
      return `What AWS account number was planted for ${id}?`;
    case "person_name":
      return `What person name was planted for ${id}?`;
    case "address":
      return `What address was planted for ${id}?`;
    case "code":
      return `What code was planted for ${id}?`;
    case "book_title":
      return `What book title was planted for ${id}?`;
    case "project_codename":
      return `What project codename was planted for ${id}?`;
    case "isbn":
      return `What ISBN was planted for ${id}?`;
    case "date_iso":
      return `What ISO date was planted for ${id}?`;
    case "birthday":
      return `What birthday was planted for ${id}?`;
    case "flight_number":
      return `What flight number was planted for ${id}?`;
    case "uuid":
      return `What UUID was planted for ${id}?`;
    case "zipcode":
      return `What ZIP code was planted for ${id}?`;
    default:
      return `What value was planted for ${id}?`;
  }
}

function buildFacts(args: Args): Fact[] {
  const facts: Fact[] = [];
  const usedTurns = new Set<number>();
  for (let i = 0; i < args.plantFacts; i++) {
    const id = `fact_${i + 1}`;
    const kind = FACT_KINDS[(i + args.seed) % FACT_KINDS.length];
    let plantedTurn = Math.max(
      1,
      Math.min(
        args.turns,
        Math.floor(((i + 1) * args.turns) / (args.plantFacts + 1)),
      ),
    );
    while (usedTurns.has(plantedTurn) && plantedTurn < args.turns)
      plantedTurn++;
    usedTurns.add(plantedTurn);
    const expected = valueForKind(kind, args.seed, i);
    facts.push({
      id,
      kind,
      expected,
      question: questionFor(kind, id),
      plantedTurn,
    });
  }
  return facts;
}

function defaultSystemPrompt(args: Args): string {
  if (!args.realisticSystemPrompt) {
    return "You are an Eliza agent. Track user-provided facts exactly and answer later recall probes with the exact value.";
  }
  return [
    "You are an Eliza agent running inside elizaOS.",
    "Maintain continuity across long conversations, respect tool results, and keep exact identifiers intact.",
    "Available actions include REPLY, TASKS, RUNTIME, SHELL, and NONE.",
    "Providers include recent messages, user profile, workspace state, runtime settings, and active integrations.",
    "When a user gives a durable fact, treat the exact value as load-bearing context for later turns.",
    "Never invent identifiers. If a value appears in prior conversation history, reproduce it exactly.",
    "Plugin descriptions: shell command execution, dashboard runtime management, cloud usage reporting, and local workspace inspection.",
    "This synthetic prompt intentionally resembles a larger production prompt so compaction has non-conversation context to preserve.",
  ].join("\n\n");
}

function renderTranscript(messages: CompactorMessage[]): string {
  return messages
    .map((message) => {
      const extras: string[] = [];
      if (message.toolCalls) {
        extras.push(` toolCalls=${JSON.stringify(message.toolCalls)}`);
      }
      if (message.toolCallId) extras.push(` toolCallId=${message.toolCallId}`);
      if (message.toolName) extras.push(` toolName=${message.toolName}`);
      return `[${message.role}]${extras.join("")} ${message.content}`;
    })
    .join("\n");
}

function extractFacts(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/FACT\s+(fact_\d+):\s+([^\n]+)/g)) {
    out.push(`${match[1]}: ${match[2].trim()}`);
  }
  for (const match of text.matchAll(
    /\[tool_result:([^\]]+)\]\s+([^\n]+?)\s+\(turn=(\d+)\)/g,
  )) {
    out.push(`tool ${match[1]} turn ${match[3]}: ${match[2].trim()}`);
  }
  return Array.from(new Set(out));
}

function extractExpectedAnswer(text: string, fact: Fact): string | null {
  const factLine = new RegExp(
    `FACT\\s+${fact.id}:\\s+[^\\n]*expected=${escapeRegExp(fact.expected)}(?:\\s|$)`,
  );
  if (factLine.test(text)) return fact.expected;
  if (text.includes(fact.expected)) return fact.expected;
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dryRunModelCall(): CompactorModelCall {
  return async ({ systemPrompt, messages }) => {
    const text = messages.map((message) => message.content).join("\n");
    const facts = extractFacts(text);
    if (
      systemPrompt.includes('"facts"') &&
      systemPrompt.includes("JSON object")
    ) {
      return JSON.stringify({
        facts,
        decisions: [],
        pending_actions: [],
        forbidden_behaviors: [],
        entities: {},
      });
    }
    if (systemPrompt.includes("hybrid ledger")) {
      return JSON.stringify({
        state: {
          facts,
          decisions: [],
          pending_actions: [],
          forbidden_behaviors: [],
          entities: {},
        },
        ledger: facts.map((fact, index) => ({ index, note: fact })),
      });
    }
    return facts.length > 0
      ? facts.map((fact) => `Preserved ${fact}`).join("\n")
      : "No durable planted facts were present in the compacted region.";
  };
}

async function chatCompletion(args: {
  model: string;
  systemPrompt: string;
  messages: CompactorMessage[];
  maxOutputTokens: number;
  reasoningEffort: ReasoningEffort;
}): Promise<string> {
  const apiKey =
    process.env.CEREBRAS_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.OPENAI_COMPAT_API_KEY;
  if (!apiKey) {
    throw new Error(
      "real drift runs require CEREBRAS_API_KEY, OPENAI_API_KEY, or OPENAI_COMPAT_API_KEY; use --dry-run for local smoke tests",
    );
  }
  const baseUrl =
    process.env.OPENAI_COMPAT_BASE_URL ??
    process.env.CEREBRAS_BASE_URL ??
    "https://api.cerebras.ai/v1";
  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: "system", content: args.systemPrompt },
          ...args.messages.map((message) => ({
            role: message.role === "tool" ? "user" : message.role,
            content: message.content,
          })),
        ],
        max_tokens: args.maxOutputTokens,
        reasoning_effort: args.reasoningEffort,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `chat completion failed (${response.status}): ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content?.trim() ?? "";
}

function realModelCall(args: Args): CompactorModelCall {
  return ({ systemPrompt, messages, maxOutputTokens }) =>
    chatCompletion({
      model: args.compactorModel,
      systemPrompt,
      messages,
      maxOutputTokens: maxOutputTokens ?? 800,
      reasoningEffort: args.compactorReasoningEffort,
    });
}

function promptStripCompact(
  transcript: CompactorTranscript,
  preserveTailMessages: number,
): CompactionArtifact {
  const startedAt = Date.now();
  const messages = transcript.messages;
  const boundary = findSafeCompactionBoundary(messages, preserveTailMessages);
  const systemPrefix = messages.filter((message, index) => {
    return (
      index < boundary &&
      (message.role === "system" || message.role === "developer")
    );
  });
  const protectedCount = systemPrefix.length;
  const region = messages.slice(protectedCount, boundary);
  const preservedTail = messages.slice(boundary);
  const stripped = region
    .map((message) => message.content)
    .join("\n")
    .replace(/\([^)]*internal thought:[^)]*\)/gi, "")
    .replace(/\([^)]*actions:[^)]*\)/gi, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const replacementMessages: CompactorMessage[] = stripped
    ? [
        {
          role: "assistant",
          content: `[conversation prompt-stripping]\n${stripped}`,
          tags: ["compactor:prompt-stripping"],
        },
      ]
    : [];
  const compacted = [...systemPrefix, ...replacementMessages, ...preservedTail];
  return {
    replacementMessages,
    stats: {
      originalMessageCount: messages.length,
      compactedMessageCount: compacted.length,
      originalTokens: countTranscriptTokens(transcript),
      compactedTokens: countTranscriptTokens({ messages: compacted }),
      latencyMs: Date.now() - startedAt,
      extra: { regionSize: region.length },
    },
  };
}

async function applyStrategy(args: {
  strategy: StrategyName;
  transcript: CompactorTranscript;
  callModel: CompactorModelCall;
}): Promise<{
  transcript: CompactorTranscript;
  stats: CompactionArtifact["stats"];
}> {
  const preserveTailMessages = 6;
  if (args.strategy === "none") {
    const tokens = countTranscriptTokens(args.transcript);
    return {
      transcript: args.transcript,
      stats: {
        originalMessageCount: args.transcript.messages.length,
        compactedMessageCount: args.transcript.messages.length,
        originalTokens: tokens,
        compactedTokens: tokens,
        latencyMs: 0,
      },
    };
  }

  const artifact =
    args.strategy === "prompt-stripping"
      ? promptStripCompact(args.transcript, preserveTailMessages)
      : await compactors[args.strategy].compact(args.transcript, {
          targetTokens: 700,
          preserveTailMessages,
          countTokens: approxCountTokens,
          callModel: args.callModel,
          summarizationModel: "drift-harness",
        });

  const messages = args.transcript.messages;
  const systemPrefixLength = messages.findIndex(
    (message) => message.role !== "system" && message.role !== "developer",
  );
  const prefixLength =
    systemPrefixLength === -1 ? messages.length : systemPrefixLength;
  const boundary = findSafeCompactionBoundary(messages, preserveTailMessages);
  return {
    transcript: {
      messages: [
        ...messages.slice(0, prefixLength),
        ...artifact.replacementMessages,
        ...messages.slice(boundary),
      ],
      metadata: args.transcript.metadata,
    },
    stats: artifact.stats,
  };
}

function emitTurn(
  lines: string[],
  turn: number,
  role: "user" | "assistant",
  content: string,
  factId?: string,
): void {
  lines.push(
    JSON.stringify({
      event: "turn",
      turn,
      role,
      contentLen: content.length,
      tokens: approxCountTokens(content),
      ...(factId ? { factId } : {}),
    }),
  );
}

async function answerProbe(args: {
  harnessArgs: Args;
  transcript: CompactorTranscript;
  fact: Fact;
}): Promise<string> {
  const transcriptText = renderTranscript(args.transcript.messages);
  if (args.harnessArgs.dryRun) {
    return (
      extractExpectedAnswer(transcriptText, args.fact) ?? "I don't recall."
    );
  }
  return chatCompletion({
    model: args.harnessArgs.agentModel,
    systemPrompt:
      "Answer the recall probe using only the supplied transcript. Return the exact value if present.",
    messages: [
      {
        role: "user",
        content: `Transcript:\n${transcriptText}\n\nProbe: ${args.fact.question}`,
      },
    ],
    maxOutputTokens: args.harnessArgs.probeMaxTokens,
    reasoningEffort: args.harnessArgs.agentReasoningEffort,
  });
}

async function judgeProbe(args: {
  harnessArgs: Args;
  fact: Fact;
  actual: string;
}): Promise<{ correct: boolean; reasoning: string }> {
  const exact = args.actual.includes(args.fact.expected);
  if (args.harnessArgs.dryRun || exact) {
    return {
      correct: exact,
      reasoning: exact
        ? "exact-match: expected substring present"
        : "exact-match: expected substring missing",
    };
  }
  const verdict = await chatCompletion({
    model: args.harnessArgs.judgeModel,
    systemPrompt:
      'Grade whether ACTUAL contains the same exact value as EXPECTED. Respond JSON: {"correct":boolean,"reasoning":"..."}.',
    messages: [
      {
        role: "user",
        content: `EXPECTED: ${args.fact.expected}\nACTUAL: ${args.actual}`,
      },
    ],
    maxOutputTokens: 200,
    reasoningEffort: args.harnessArgs.judgeReasoningEffort,
  });
  try {
    const parsed = JSON.parse(verdict) as {
      correct?: boolean;
      reasoning?: string;
    };
    return {
      correct: parsed.correct === true,
      reasoning: parsed.reasoning ?? "judge-json",
    };
  } catch {
    return {
      correct: exact,
      reasoning: `judge-unparseable; exact-match=${exact}`,
    };
  }
}

async function probeFacts(args: {
  harnessArgs: Args;
  transcript: CompactorTranscript;
  facts: Fact[];
  lines: string[];
  atTurn: number;
  phase: ProbeEvent["phase"];
}): Promise<ProbeEvent[]> {
  const events: ProbeEvent[] = [];
  for (const fact of args.facts.filter(
    (item) => item.plantedTurn <= args.atTurn,
  )) {
    const actual = await answerProbe({
      harnessArgs: args.harnessArgs,
      transcript: args.transcript,
      fact,
    });
    const judgment = await judgeProbe({
      harnessArgs: args.harnessArgs,
      fact,
      actual,
    });
    const event: ProbeEvent = {
      event: "probe",
      atTurn: args.atTurn,
      factId: fact.id,
      plantedTurn: fact.plantedTurn,
      kind: fact.kind,
      expected: fact.expected,
      actual,
      correct: judgment.correct,
      judgeReasoning: judgment.reasoning,
      phase: args.phase,
    };
    args.lines.push(JSON.stringify(event));
    events.push(event);
  }
  return events;
}

function addToolCallMessages(
  messages: CompactorMessage[],
  lines: string[],
  turn: number,
  facts: Fact[],
  seed: number,
): void {
  const toolName = "lookup_context";
  const expected = `TOOL-${padded(seed, turn, 6)}`;
  const fact: Fact = {
    id: `tool_${turn}`,
    kind: "tool_result",
    expected,
    plantedTurn: turn,
    question: `What did ${toolName} return at turn ${turn}?`,
  };
  facts.push(fact);
  const assistant: CompactorMessage = {
    role: "assistant",
    content: `[tool_call:${toolName}] requesting synthetic value for turn ${turn}`,
    toolCalls: [{ id: `call_${turn}`, name: toolName, arguments: { turn } }],
  };
  const tool: CompactorMessage = {
    role: "tool",
    toolCallId: `call_${turn}`,
    toolName,
    content: `[tool_result:${toolName}] ${expected} (turn=${turn})`,
  };
  messages.push(assistant, tool);
  emitTurn(lines, turn, "assistant", assistant.content);
  lines.push(
    JSON.stringify({
      event: "turn",
      turn,
      role: "tool",
      contentLen: tool.content.length,
      tokens: approxCountTokens(tool.content),
      factId: fact.id,
    }),
  );
}

async function main(): Promise<number> {
  const args = parseArgs(Bun.argv.slice(2));
  const facts = buildFacts(args);
  const factsByTurn = new Map<number, Fact[]>();
  for (const fact of facts) {
    const items = factsByTurn.get(fact.plantedTurn) ?? [];
    items.push(fact);
    factsByTurn.set(fact.plantedTurn, items);
  }

  const lines: string[] = [];
  const transcript: CompactorTranscript = {
    messages: [{ role: "system", content: defaultSystemPrompt(args) }],
    metadata: { seed: args.seed, strategy: args.strategy },
  };
  const callModel = args.dryRun ? dryRunModelCall() : realModelCall(args);
  let totalCompactions = 0;
  let totalTokensSaved = 0;
  const probes: ProbeEvent[] = [];

  for (let turn = 1; turn <= args.turns; turn++) {
    const planted = factsByTurn.get(turn) ?? [];
    const durableFacts = planted.map(
      (fact) =>
        `FACT ${fact.id}: kind=${fact.kind} expected=${fact.expected} question="${fact.question}"`,
    );
    const filler = `Turn ${turn}: continue the planning conversation and keep prior durable facts available.`;
    const userContent = [filler, ...durableFacts].join("\n");
    transcript.messages.push({ role: "user", content: userContent });
    emitTurn(lines, turn, "user", userContent, planted[0]?.id);

    const assistantContent = planted.length
      ? `Acknowledged ${planted.map((fact) => fact.id).join(", ")}.`
      : `Acknowledged turn ${turn}.`;
    transcript.messages.push({ role: "assistant", content: assistantContent });
    emitTurn(lines, turn, "assistant", assistantContent);

    if (args.withToolCalls && turn % 5 === 0) {
      addToolCallMessages(transcript.messages, lines, turn, facts, args.seed);
    }

    if (turn % args.compactEvery === 0 && args.strategy !== "none") {
      const result = await applyStrategy({
        strategy: args.strategy,
        transcript,
        callModel,
      });
      transcript.messages = result.transcript.messages;
      totalCompactions++;
      totalTokensSaved += Math.max(
        0,
        result.stats.originalTokens - result.stats.compactedTokens,
      );
      lines.push(
        JSON.stringify({
          event: "compact",
          atTurn: turn,
          strategy: args.strategy,
          originalTokens: result.stats.originalTokens,
          compactedTokens: result.stats.compactedTokens,
          latencyMs: result.stats.latencyMs,
        }),
      );
      probes.push(
        ...(await probeFacts({
          harnessArgs: args,
          transcript,
          facts,
          lines,
          atTurn: turn,
          phase: "post-compact",
        })),
      );
    }
  }

  probes.push(
    ...(await probeFacts({
      harnessArgs: args,
      transcript,
      facts,
      lines,
      atTurn: args.turns,
      phase: "final",
    })),
  );

  const totalCorrect = probes.filter((probe) => probe.correct).length;
  const perKind = new Map<string, { correct: number; total: number }>();
  for (const probe of probes) {
    const stats = perKind.get(probe.kind) ?? { correct: 0, total: 0 };
    stats.total++;
    if (probe.correct) stats.correct++;
    perKind.set(probe.kind, stats);
  }
  const perKindAccuracy = Object.fromEntries(
    Array.from(perKind.entries()).map(([kind, stats]) => [
      kind,
      {
        correct: stats.correct,
        total: stats.total,
        accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
      },
    ]),
  );

  lines.push(
    JSON.stringify({
      event: "summary",
      strategy: args.strategy,
      overallAccuracy: probes.length > 0 ? totalCorrect / probes.length : 0,
      totalCompactions,
      totalTokensSaved,
      totalProbes: probes.length,
      totalCorrect,
      seed: args.seed,
      turns: args.turns,
      compactEvery: args.compactEvery,
      plantFacts: args.plantFacts,
      valid: true,
      skipped: false,
      perKindAccuracy,
    }),
  );

  const output = `${lines.join("\n")}\n`;
  if (args.output) {
    await Bun.write(args.output, output);
  }
  process.stdout.write(output);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
    );
    process.exit(1);
  },
);
