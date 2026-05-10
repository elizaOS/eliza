#!/usr/bin/env bun
/**
 * Long-running NIAH-style drift harness.
 *
 * Drives multi-turn synthetic conversations through a chosen model (real
 * Cerebras gpt-oss-120b by default; a fake offline model under --dry-run),
 * forces compaction on a fixed cadence using a chosen strategy, then probes
 * planted facts at every compaction event and at end-of-run to measure
 * whether the facts survive.
 *
 * Output: JSONL — one line per turn, one per compaction event, one per probe,
 * and a final summary line. All scoring is reproducible from the JSONL alone.
 *
 * Run:
 *   bun run scripts/benchmark/drift-harness.ts --strategy none --turns 50 \
 *     --compact-every 10 --plant-facts 5 --output results.jsonl
 *
 *   # offline plumbing smoke test:
 *   bun run scripts/benchmark/drift-harness.ts --strategy none --turns 3 \
 *     --compact-every 100 --plant-facts 1 --output /tmp/drift.jsonl --dry-run
 */

// ---------------------------------------------------------------------------
// CLI parsing (no deps — built-in)
// ---------------------------------------------------------------------------

export type StrategyName =
  | "none"
  | "prompt-stripping"
  | "naive-summary"
  | "structured-state"
  | "hierarchical-summary"
  | "hybrid-ledger";

export const KNOWN_STRATEGIES: readonly StrategyName[] = [
  "none",
  "prompt-stripping",
  "naive-summary",
  "structured-state",
  "hierarchical-summary",
  "hybrid-ledger",
] as const;

export type CliArgs = {
  strategy: StrategyName;
  turns: number;
  compactEvery: number;
  plantFacts: number;
  output: string;
  seed: number;
  dryRun: boolean;
  model: string;
  baseUrl: string;
  judgeModel: string;
  help: boolean;
};

export const DEFAULT_ARGS: CliArgs = {
  strategy: "none",
  turns: 50,
  compactEvery: 10,
  plantFacts: 5,
  output: "drift-results.jsonl",
  seed: 1337,
  dryRun: false,
  model: "gpt-oss-120b",
  baseUrl: "https://api.cerebras.ai/v1",
  judgeModel: "gpt-oss-120b",
  help: false,
};

const HELP_TEXT = `drift-harness — NIAH-style drift benchmark for Eliza compactors

Usage:
  bun run scripts/benchmark/drift-harness.ts [flags]

Flags:
  --strategy <name>      Compaction strategy: ${KNOWN_STRATEGIES.join(" | ")} (default: none)
  --turns <n>            Total conversation turns (default: 50)
  --compact-every <n>    Compact every N turns (default: 10)
  --plant-facts <n>      Number of facts to plant across the run (default: 5)
  --output <path>        JSONL output path (default: drift-results.jsonl)
  --seed <n>             Deterministic seed (default: 1337)
  --model <id>           Agent model id (default: gpt-oss-120b)
  --judge-model <id>     Judge model id (default: gpt-oss-120b)
  --base-url <url>       OpenAI-compatible endpoint (default: Cerebras)
  --dry-run              Use a fake model (no API calls); for plumbing tests
  --help, -h             Show this help

Env:
  CEREBRAS_API_KEY       Required unless --dry-run
`;

export function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { ...DEFAULT_ARGS };
  const need = (i: number, flag: string): string => {
    if (i + 1 >= argv.length) {
      throw new Error(`flag ${flag} requires a value`);
    }
    return argv[i + 1]!;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--strategy": {
        const v = need(i, a) as StrategyName;
        if (!KNOWN_STRATEGIES.includes(v)) {
          throw new Error(
            `unknown strategy ${v}; expected one of ${KNOWN_STRATEGIES.join(", ")}`,
          );
        }
        out.strategy = v;
        i++;
        break;
      }
      case "--turns":
        out.turns = parseIntStrict(need(i, a), a);
        i++;
        break;
      case "--compact-every":
        out.compactEvery = parseIntStrict(need(i, a), a);
        i++;
        break;
      case "--plant-facts":
        out.plantFacts = parseIntStrict(need(i, a), a);
        i++;
        break;
      case "--seed":
        out.seed = parseIntStrict(need(i, a), a);
        i++;
        break;
      case "--output":
        out.output = need(i, a);
        i++;
        break;
      case "--model":
        out.model = need(i, a);
        i++;
        break;
      case "--judge-model":
        out.judgeModel = need(i, a);
        i++;
        break;
      case "--base-url":
        out.baseUrl = need(i, a);
        i++;
        break;
      default:
        if (a.startsWith("--")) {
          throw new Error(`unknown flag ${a}`);
        }
    }
  }
  if (out.turns <= 0) throw new Error("--turns must be positive");
  if (out.compactEvery <= 0) throw new Error("--compact-every must be positive");
  if (out.plantFacts < 0) throw new Error("--plant-facts must be >= 0");
  if (out.plantFacts > out.turns) {
    throw new Error("--plant-facts cannot exceed --turns");
  }
  return out;
}

function parseIntStrict(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`flag ${flag} expects an integer, got ${raw}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32)
// ---------------------------------------------------------------------------

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fact planting
// ---------------------------------------------------------------------------

export type FactKind = "aws_account" | "api_key" | "person_name" | "address" | "code";

export type PlantedFact = {
  id: string;
  turn: number;
  kind: FactKind;
  /** What the user "says" to plant the fact. */
  utterance: string;
  /** The exact value the model must reproduce (or be semantically near). */
  expected: string;
  /** The probe question. */
  question: string;
  /** True for ID-like kinds where exact match is required. */
  exactMatch: boolean;
};

const FILLER_QUESTIONS: readonly string[] = [
  "Tell me a quick joke.",
  "What's a fun fact about octopuses?",
  "Recommend a good book to read on a flight.",
  "Suggest a simple pasta recipe.",
  "What's a productivity tip for remote work?",
  "Name a small city worth visiting in Europe.",
  "What's the difference between weather and climate?",
  "Suggest a stretch I can do at my desk.",
  "What's a simple breathing exercise?",
  "Pick a random color and describe it.",
] as const;

export function planFacts(args: {
  totalTurns: number;
  count: number;
  seed: number;
}): PlantedFact[] {
  const { totalTurns, count, seed } = args;
  if (count === 0) return [];
  const rand = rng(seed);
  // Spread plant turns across the run. Always plant at least one early so
  // there is a meaningful test of survival across compactions.
  const turns = new Set<number>();
  // Turn 0 is reserved for the system message; plants land at turn >= 1.
  while (turns.size < count) {
    const t = 1 + Math.floor(rand() * Math.max(1, totalTurns - 1));
    turns.add(t);
  }
  const sorted = [...turns].sort((a, b) => a - b);

  const out: PlantedFact[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    const kind = pickKind(rand);
    const fact = makeFact(kind, rand);
    out.push({
      id: `fact_${i + 1}`,
      turn: t,
      kind,
      utterance: fact.utterance,
      expected: fact.expected,
      question: fact.question,
      exactMatch: fact.exactMatch,
    });
  }
  return out;
}

function pickKind(rand: () => number): FactKind {
  const kinds: FactKind[] = [
    "aws_account",
    "api_key",
    "person_name",
    "address",
    "code",
  ];
  return kinds[Math.floor(rand() * kinds.length)]!;
}

function makeFact(kind: FactKind, rand: () => number): {
  utterance: string;
  expected: string;
  question: string;
  exactMatch: boolean;
} {
  switch (kind) {
    case "aws_account": {
      const id = String(Math.floor(rand() * 1e12)).padStart(12, "0");
      return {
        utterance: `By the way, my AWS account ID is ${id}. Please remember it.`,
        expected: id,
        question: "What is my AWS account ID?",
        exactMatch: true,
      };
    }
    case "api_key": {
      const key = `sk_${randHex(rand, 24)}`;
      return {
        utterance: `Note: my staging API key is ${key}. Keep it on file.`,
        expected: key,
        question: "What is my staging API key?",
        exactMatch: true,
      };
    }
    case "person_name": {
      const first = pick(rand, ["Mira", "Jules", "Aki", "Ramon", "Soren", "Zane"]);
      const last = pick(rand, ["Tanaka", "Okafor", "Ramirez", "Lindholm", "Khoury"]);
      return {
        utterance: `My contact at the vendor is ${first} ${last}, just FYI.`,
        expected: `${first} ${last}`,
        question: "Who is my contact at the vendor?",
        exactMatch: true,
      };
    }
    case "address": {
      const num = 100 + Math.floor(rand() * 9000);
      const street = pick(rand, ["Pine", "Maple", "Cedar", "Birch", "Elm"]);
      const city = pick(rand, ["Boulder", "Asheville", "Bend", "Ithaca"]);
      const expected = `${num} ${street} St, ${city}`;
      return {
        utterance: `Ship to: ${expected}. That's the new office.`,
        expected,
        question: "What is the new office shipping address?",
        exactMatch: false,
      };
    }
    case "code": {
      const code = randHex(rand, 8).toUpperCase();
      return {
        utterance: `Project codename for this quarter: ${code}.`,
        expected: code,
        question: "What is this quarter's project codename?",
        exactMatch: true,
      };
    }
  }
}

function randHex(rand: () => number, len: number): string {
  const chars = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * 16)]!;
  return s;
}

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)]!;
}

// ---------------------------------------------------------------------------
// Conversation generation
// ---------------------------------------------------------------------------

export type Turn = {
  index: number;
  role: "user" | "assistant";
  content: string;
  factId?: string;
};

export function buildUserTurn(args: {
  index: number;
  rand: () => number;
  fact?: PlantedFact;
}): Turn {
  const { index, rand, fact } = args;
  if (fact) {
    return {
      index,
      role: "user",
      content: fact.utterance,
      factId: fact.id,
    };
  }
  const q = FILLER_QUESTIONS[Math.floor(rand() * FILLER_QUESTIONS.length)]!;
  return { index, role: "user", content: q };
}

// ---------------------------------------------------------------------------
// Token approximation (4 chars/token heuristic — matches Compactor types)
// ---------------------------------------------------------------------------

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Model invocation (Cerebras / OpenAI-compatible)
// ---------------------------------------------------------------------------

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ModelClient = {
  chat(args: {
    model: string;
    messages: ChatMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ content: string; latencyMs: number }>;
};

const DEFAULT_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export function makeOpenAICompatibleClient(opts: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  baseBackoffMs?: number;
}): ModelClient {
  const f = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseBackoff = opts.baseBackoffMs ?? BASE_BACKOFF_MS;
  return {
    async chat({ model, messages, maxTokens, temperature }) {
      const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const body = JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: temperature ?? 0.7,
      });
      let lastErr: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const start = Date.now();
        try {
          const resp = await f(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${opts.apiKey}`,
            },
            body,
          });
          if (resp.status === 429 || resp.status >= 500) {
            const text = await safeReadText(resp);
            lastErr = new Error(
              `upstream ${resp.status}: ${text.slice(0, 200)}`,
            );
            if (attempt === retries) break;
            await sleep(baseBackoff * Math.pow(2, attempt));
            continue;
          }
          if (!resp.ok) {
            const text = await safeReadText(resp);
            throw new Error(
              `upstream ${resp.status}: ${text.slice(0, 200)}`,
            );
          }
          const data = (await resp.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = data.choices?.[0]?.message?.content ?? "";
          return { content, latencyMs: Date.now() - start };
        } catch (err) {
          lastErr = err;
          if (attempt === retries) break;
          await sleep(baseBackoff * Math.pow(2, attempt));
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error(String(lastErr ?? "unknown upstream failure"));
    },
  };
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Offline fake model: always returns a deterministic response that includes
 * any planted-fact value it sees in the latest user message and that
 * remembers facts only when they are present in the visible context window.
 * Used for --dry-run and unit tests.
 */
export function makeFakeClient(): ModelClient {
  return {
    async chat({ messages }) {
      const last = messages[messages.length - 1];
      const text = last?.content ?? "";
      // If asked a probe question, scan the conversation for the plausible
      // fact value and echo it. This makes the fake client a faithful
      // baseline: facts present in context survive, facts that have been
      // compacted away are forgotten.
      if (/AWS account ID/i.test(text)) {
        return scanAndAnswer(messages, /AWS account ID is (\d{12})/i);
      }
      if (/staging API key/i.test(text)) {
        return scanAndAnswer(messages, /staging API key is (sk_[0-9a-f]+)/i);
      }
      if (/contact at the vendor/i.test(text)) {
        return scanAndAnswer(messages, /vendor is ([A-Z][a-z]+ [A-Z][a-z]+)/);
      }
      if (/shipping address/i.test(text)) {
        return scanAndAnswer(messages, /Ship to: ([^.]+)\./);
      }
      if (/codename/i.test(text)) {
        return scanAndAnswer(messages, /codename for this quarter: ([A-Z0-9]+)/);
      }
      return { content: "Sure, here's a friendly reply.", latencyMs: 1 };
    },
  };
}

function scanAndAnswer(
  messages: readonly ChatMessage[],
  re: RegExp,
): { content: string; latencyMs: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const hit = m.content.match(re);
    if (hit && hit[1]) return { content: hit[1], latencyMs: 1 };
  }
  return { content: "I don't recall that detail.", latencyMs: 1 };
}

// ---------------------------------------------------------------------------
// Compaction strategies
// ---------------------------------------------------------------------------

export type CompactionResult = {
  /** Replaces the compacted prefix; tail messages are preserved as-is. */
  newMessages: ChatMessage[];
  originalTokens: number;
  compactedTokens: number;
  latencyMs: number;
  /** True if the strategy was unavailable; caller should treat run as skipped. */
  unavailable?: boolean;
  unavailableReason?: string;
};

export type CompactionInputs = {
  messages: ChatMessage[];
  preserveTail: number;
};

/**
 * Apply prompt-stripping baseline: collapse repeated whitespace, drop greetings.
 * Intentionally trivial; this is the regex baseline being measured against.
 */
function applyPromptStripping(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    content: m.content
      .replace(/\s+/g, " ")
      .replace(/^(hi|hello|hey)[!,. ]+/i, "")
      .trim(),
  }));
}

/**
 * Naive summary baseline (no model call required for offline mode): collapses
 * the prefix into a single system message that lists message counts only.
 * This is the worst-case "summary" that drops planted facts and exists so we
 * can reproduce drift even without the upstream summarization compactor.
 */
function applyNaiveSummaryFallback(prefix: ChatMessage[]): ChatMessage[] {
  const userCount = prefix.filter((m) => m.role === "user").length;
  const asstCount = prefix.filter((m) => m.role === "assistant").length;
  return [
    {
      role: "system",
      content: `[Summary] Conversation so far had ${userCount} user turns and ${asstCount} assistant turns covering general small talk.`,
    },
  ];
}

export async function applyCompaction(args: {
  strategy: StrategyName;
  inputs: CompactionInputs;
  /**
   * Loader for runtime compactor strategies. Returns `null` when the
   * upstream package has not landed yet — caller must log + skip rather
   * than crashing.
   */
  loadCompactor?: (
    name: StrategyName,
  ) => Promise<{
    compact: (messages: ChatMessage[]) => Promise<ChatMessage[]>;
  } | null>;
}): Promise<CompactionResult> {
  const { strategy, inputs } = args;
  const { messages, preserveTail } = inputs;
  const start = Date.now();
  const splitAt = Math.max(0, messages.length - preserveTail);
  const prefix = messages.slice(0, splitAt);
  const tail = messages.slice(splitAt);
  const originalTokens = approxTokensMessages(messages);

  if (strategy === "none") {
    return {
      newMessages: messages,
      originalTokens,
      compactedTokens: originalTokens,
      latencyMs: Date.now() - start,
    };
  }

  if (strategy === "prompt-stripping") {
    const stripped = applyPromptStripping(messages);
    return {
      newMessages: stripped,
      originalTokens,
      compactedTokens: approxTokensMessages(stripped),
      latencyMs: Date.now() - start,
    };
  }

  // For the four runtime strategies, try to load the upstream compactor.
  // If that file does not exist yet, we report unavailable and the caller
  // logs + continues. We never silently fall back to a different strategy.
  if (args.loadCompactor) {
    const impl = await args.loadCompactor(strategy);
    if (impl === null) {
      return {
        newMessages: messages,
        originalTokens,
        compactedTokens: originalTokens,
        latencyMs: Date.now() - start,
        unavailable: true,
        unavailableReason: `compactor ${strategy} not yet implemented in conversation-compactor.ts`,
      };
    }
    const compactedPrefix = await impl.compact(prefix);
    const newMessages = [...compactedPrefix, ...tail];
    return {
      newMessages,
      originalTokens,
      compactedTokens: approxTokensMessages(newMessages),
      latencyMs: Date.now() - start,
    };
  }

  // No loader supplied (e.g. unit tests). Fall back to naive summary so the
  // pipeline still produces a measurable (lossy) compaction event.
  const compactedPrefix = applyNaiveSummaryFallback(prefix);
  const newMessages = [...compactedPrefix, ...tail];
  return {
    newMessages,
    originalTokens,
    compactedTokens: approxTokensMessages(newMessages),
    latencyMs: Date.now() - start,
  };
}

function approxTokensMessages(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += approxTokens(m.content);
  return total;
}

/**
 * Default loader: imports the upstream compactor module if it exists,
 * returns null otherwise. Kept narrow so the harness never crashes when
 * the parallel agent's work has not yet landed.
 */
export async function defaultCompactorLoader(
  name: StrategyName,
): Promise<{ compact: (messages: ChatMessage[]) => Promise<ChatMessage[]> } | null> {
  try {
    // Dynamic import — path-resolution failure is treated as "not yet implemented".
    const mod = (await import(
      "../../packages/agent/src/runtime/conversation-compactor.ts"
    )) as Record<string, unknown>;
    const lookup: Record<StrategyName, string> = {
      "naive-summary": "naiveSummaryCompactor",
      "structured-state": "structuredStateCompactor",
      "hierarchical-summary": "hierarchicalSummaryCompactor",
      "hybrid-ledger": "hybridLedgerCompactor",
      none: "",
      "prompt-stripping": "",
    };
    const key = lookup[name];
    const fn = key ? mod[key] : undefined;
    if (typeof fn !== "function") return null;
    return {
      async compact(messages) {
        // The upstream compactor exposes the Compactor interface from
        // conversation-compactor.types.ts. We adapt our ChatMessage[] to
        // its CompactorTranscript.
        const transcript = {
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        };
        const artifact = await (
          fn as (t: unknown, o: unknown) => Promise<{
            replacementMessages: Array<{ role: string; content: string }>;
          }>
        )(transcript, { targetTokens: 1024, preserveTailMessages: 0 });
        return artifact.replacementMessages.map((m) => ({
          role: m.role as ChatMessage["role"],
          content: m.content,
        }));
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

export type ProbeOutcome = {
  factId: string;
  turn: number;
  expected: string;
  actual: string;
  correct: boolean;
  judgeReasoning: string;
};

export async function probeFact(args: {
  client: ModelClient;
  model: string;
  judgeModel: string;
  judgeWithModel: boolean;
  history: ChatMessage[];
  fact: PlantedFact;
  systemPrompt: string;
  /** When supplied, used as the judge instead of `client.chat`. */
  judgeFn?: (args: {
    expected: string;
    actual: string;
    question: string;
  }) => Promise<{ correct: boolean; reasoning: string }>;
}): Promise<ProbeOutcome> {
  const { client, model, history, fact, systemPrompt } = args;
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: fact.question },
  ];
  const resp = await client.chat({ model, messages, maxTokens: 200, temperature: 0 });
  const actual = resp.content.trim();
  if (fact.exactMatch) {
    const correct = actual.includes(fact.expected);
    return {
      factId: fact.id,
      turn: fact.turn,
      expected: fact.expected,
      actual,
      correct,
      judgeReasoning: correct
        ? "exact-match: expected substring present"
        : "exact-match: expected substring missing",
    };
  }
  // Prose / address: judge with model unless a judgeFn is supplied (tests).
  const judge = args.judgeFn
    ? await args.judgeFn({
        expected: fact.expected,
        actual,
        question: fact.question,
      })
    : await modelJudge({
        client,
        model: args.judgeModel,
        expected: fact.expected,
        actual,
        question: fact.question,
      });
  return {
    factId: fact.id,
    turn: fact.turn,
    expected: fact.expected,
    actual,
    correct: judge.correct,
    judgeReasoning: judge.reasoning,
  };
}

async function modelJudge(args: {
  client: ModelClient;
  model: string;
  expected: string;
  actual: string;
  question: string;
}): Promise<{ correct: boolean; reasoning: string }> {
  const sys = [
    "You are a strict grader.",
    "Decide whether the assistant's answer is semantically correct given the expected reference.",
    'Reply with a single JSON object: {"correct": true|false, "reasoning": "<one sentence>"}',
    "Do not include any other text.",
  ].join(" ");
  const user = [
    `Question: ${args.question}`,
    `Expected: ${args.expected}`,
    `Actual: ${args.actual}`,
  ].join("\n");
  const resp = await args.client.chat({
    model: args.model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    maxTokens: 200,
    temperature: 0,
  });
  return parseJudgeResponse(resp.content);
}

export function parseJudgeResponse(raw: string): {
  correct: boolean;
  reasoning: string;
} {
  // Tolerate code-fenced JSON or extra prose around the object.
  const objMatch = raw.match(/\{[\s\S]*\}/);
  const text = objMatch ? objMatch[0] : raw;
  try {
    const parsed = JSON.parse(text) as { correct?: unknown; reasoning?: unknown };
    const correct = parsed.correct === true;
    const reasoning =
      typeof parsed.reasoning === "string" ? parsed.reasoning : "no reasoning";
    return { correct, reasoning };
  } catch {
    // Fallback: look for an explicit "true"/"false" near the start of the answer.
    const lc = raw.toLowerCase();
    const correct = /\btrue\b/.test(lc) && !/\bfalse\b/.test(lc.slice(0, lc.indexOf("true") + 4));
    return { correct, reasoning: "could not parse judge JSON" };
  }
}

// ---------------------------------------------------------------------------
// JSONL writer (collects in memory; flushed at end so callers can inspect)
// ---------------------------------------------------------------------------

export type JsonlEvent =
  | { event: "turn"; turn: number; role: "user" | "assistant"; contentLen: number; tokens: number; factId?: string }
  | {
      event: "compact";
      atTurn: number;
      strategy: StrategyName;
      originalTokens: number;
      compactedTokens: number;
      latencyMs: number;
      unavailable?: boolean;
      unavailableReason?: string;
    }
  | {
      event: "probe";
      atTurn: number;
      factId: string;
      plantedTurn: number;
      expected: string;
      actual: string;
      correct: boolean;
      judgeReasoning: string;
      phase: "post-compact" | "final";
    }
  | {
      event: "summary";
      strategy: StrategyName;
      overallAccuracy: number;
      totalCompactions: number;
      totalTokensSaved: number;
      totalProbes: number;
      totalCorrect: number;
      seed: number;
      turns: number;
      compactEvery: number;
      plantFacts: number;
    };

export class JsonlSink {
  readonly events: JsonlEvent[] = [];
  push(e: JsonlEvent): void {
    this.events.push(e);
  }
  serialize(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
}

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are a helpful assistant. Be concise. Remember anything the user tells you to remember.";

export type RunOptions = {
  args: CliArgs;
  client: ModelClient;
  loadCompactor?: (
    name: StrategyName,
  ) => Promise<{ compact: (messages: ChatMessage[]) => Promise<ChatMessage[]> } | null>;
  /** Optional judge override (used in unit tests). */
  judgeFn?: (args: {
    expected: string;
    actual: string;
    question: string;
  }) => Promise<{ correct: boolean; reasoning: string }>;
};

export async function runDriftHarness(opts: RunOptions): Promise<JsonlSink> {
  const { args, client } = opts;
  const sink = new JsonlSink();
  const facts = planFacts({
    totalTurns: args.turns,
    count: args.plantFacts,
    seed: args.seed,
  });
  const factByTurn = new Map<number, PlantedFact>();
  for (const f of facts) factByTurn.set(f.turn, f);

  const rand = rng(args.seed ^ 0x9e3779b9);
  const history: ChatMessage[] = [];
  let totalCompactions = 0;
  let totalTokensSaved = 0;
  let totalProbes = 0;
  let totalCorrect = 0;

  for (let i = 1; i <= args.turns; i++) {
    const fact = factByTurn.get(i);
    const userTurn = buildUserTurn({ index: i, rand, fact });
    history.push({ role: "user", content: userTurn.content });
    sink.push({
      event: "turn",
      turn: i,
      role: "user",
      contentLen: userTurn.content.length,
      tokens: approxTokens(userTurn.content),
      factId: fact?.id,
    });

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
    ];
    const resp = await client.chat({
      model: args.model,
      messages,
      maxTokens: 256,
      temperature: 0.7,
    });
    history.push({ role: "assistant", content: resp.content });
    sink.push({
      event: "turn",
      turn: i,
      role: "assistant",
      contentLen: resp.content.length,
      tokens: approxTokens(resp.content),
    });

    const shouldCompact = i % args.compactEvery === 0 && i < args.turns;
    if (shouldCompact) {
      const result = await applyCompaction({
        strategy: args.strategy,
        inputs: { messages: history, preserveTail: 4 },
        loadCompactor: opts.loadCompactor,
      });
      sink.push({
        event: "compact",
        atTurn: i,
        strategy: args.strategy,
        originalTokens: result.originalTokens,
        compactedTokens: result.compactedTokens,
        latencyMs: result.latencyMs,
        ...(result.unavailable
          ? {
              unavailable: true,
              unavailableReason: result.unavailableReason ?? "unavailable",
            }
          : {}),
      });
      if (result.unavailable) {
        // Caller-level concern: we keep going so that --strategy <name>
        // reports its skipped state in the summary line. Probes still run
        // against the un-compacted history, which is fine — that becomes
        // the upper-bound baseline for the missing strategy.
      } else {
        totalCompactions++;
        totalTokensSaved += result.originalTokens - result.compactedTokens;
        // Replace history with the compacted version (system message lives
        // outside `history`; we strip it from the result if present).
        history.length = 0;
        for (const m of result.newMessages) {
          if (m.role === "system" && history.length === 0) {
            // First system message becomes part of the compacted summary
            // and is treated as user-visible context. Push it as-is.
            history.push(m);
            continue;
          }
          history.push(m);
        }
      }

      // Probe every planted fact whose turn <= i.
      for (const f of facts) {
        if (f.turn > i) continue;
        const outcome = await probeFact({
          client,
          model: args.model,
          judgeModel: args.judgeModel,
          judgeWithModel: !args.dryRun,
          history,
          fact: f,
          systemPrompt: SYSTEM_PROMPT,
          judgeFn: opts.judgeFn,
        });
        totalProbes++;
        if (outcome.correct) totalCorrect++;
        sink.push({
          event: "probe",
          atTurn: i,
          factId: outcome.factId,
          plantedTurn: outcome.turn,
          expected: outcome.expected,
          actual: outcome.actual,
          correct: outcome.correct,
          judgeReasoning: outcome.judgeReasoning,
          phase: "post-compact",
        });
      }
    }
  }

  // Final probe of every planted fact.
  for (const f of facts) {
    const outcome = await probeFact({
      client,
      model: args.model,
      judgeModel: args.judgeModel,
      judgeWithModel: !args.dryRun,
      history,
      fact: f,
      systemPrompt: SYSTEM_PROMPT,
      judgeFn: opts.judgeFn,
    });
    totalProbes++;
    if (outcome.correct) totalCorrect++;
    sink.push({
      event: "probe",
      atTurn: args.turns,
      factId: outcome.factId,
      plantedTurn: outcome.turn,
      expected: outcome.expected,
      actual: outcome.actual,
      correct: outcome.correct,
      judgeReasoning: outcome.judgeReasoning,
      phase: "final",
    });
  }

  const overallAccuracy = totalProbes > 0 ? totalCorrect / totalProbes : 0;
  sink.push({
    event: "summary",
    strategy: args.strategy,
    overallAccuracy,
    totalCompactions,
    totalTokensSaved,
    totalProbes,
    totalCorrect,
    seed: args.seed,
    turns: args.turns,
    compactEvery: args.compactEvery,
    plantFacts: args.plantFacts,
  });
  return sink;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n\n${HELP_TEXT}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  let client: ModelClient;
  if (args.dryRun) {
    client = makeFakeClient();
  } else {
    const apiKey = process.env.CEREBRAS_API_KEY;
    if (!apiKey) {
      process.stderr.write(
        "error: CEREBRAS_API_KEY is required (or pass --dry-run for offline plumbing tests)\n",
      );
      return 2;
    }
    client = makeOpenAICompatibleClient({ baseUrl: args.baseUrl, apiKey });
  }
  const sink = await runDriftHarness({
    args,
    client,
    loadCompactor: args.dryRun ? undefined : defaultCompactorLoader,
  });
  await Bun.write(args.output, sink.serialize());
  const summary = sink.events.find((e) => e.event === "summary");
  if (summary && summary.event === "summary") {
    process.stdout.write(
      `[harness] strategy=${summary.strategy} accuracy=${(summary.overallAccuracy * 100).toFixed(1)}% ` +
        `compactions=${summary.totalCompactions} tokensSaved=${summary.totalTokensSaved} ` +
        `probes=${summary.totalProbes} → ${args.output}\n`,
    );
  }
  // Surface unavailable strategies as a non-fatal note.
  const unavailable = sink.events.find(
    (e) => e.event === "compact" && e.event === "compact" && e.unavailable,
  );
  if (unavailable && unavailable.event === "compact" && unavailable.unavailable) {
    process.stdout.write(
      `[harness] strategy ${args.strategy} not yet implemented — skipping (${unavailable.unavailableReason ?? ""})\n`,
    );
  }
  return 0;
}

// Bun-friendly entry guard. Avoid Node-only `require.main` checks.
const isMain =
  typeof Bun !== "undefined" && import.meta.url === Bun.main
    ? true
    : typeof process !== "undefined" &&
        process.argv[1] &&
        import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isMain) {
  const argv = process.argv.slice(2);
  main(argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
