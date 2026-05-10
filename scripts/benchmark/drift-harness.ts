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

export type ReasoningEffort = "low" | "medium" | "high";

export const KNOWN_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
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
  agentReasoningEffort: ReasoningEffort;
  judgeReasoningEffort: ReasoningEffort;
  compactorReasoningEffort: ReasoningEffort;
  realisticSystemPrompt: boolean;
  withToolCalls: boolean;
  probeMaxTokens: number;
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
  agentReasoningEffort: "medium",
  judgeReasoningEffort: "medium",
  compactorReasoningEffort: "low",
  realisticSystemPrompt: false,
  withToolCalls: false,
  probeMaxTokens: 600,
  help: false,
};

const HELP_TEXT = `drift-harness — NIAH-style drift benchmark for Eliza compactors

Usage:
  bun run scripts/benchmark/drift-harness.ts [flags]

Flags:
  --strategy <name>            Compaction strategy: ${KNOWN_STRATEGIES.join(" | ")} (default: none)
  --turns <n>                  Total conversation turns (default: 50)
  --compact-every <n>          Compact every N turns (default: 10)
  --plant-facts <n>            Number of facts to plant across the run (default: 5)
  --output <path>              JSONL output path (default: drift-results.jsonl)
  --seed <n>                   Deterministic seed (default: 1337)
  --model <id>                 Agent model id (default: gpt-oss-120b)
  --judge-model <id>           Judge model id (defaults to --model; set
                               distinct to avoid same-model judge bias)
  --base-url <url>             OpenAI-compatible endpoint (default: Cerebras)
  --agent-reasoning-effort <e> Reasoning effort for agent turns (low|medium|high, default: medium)
  --judge-reasoning-effort <e> Reasoning effort for judge calls (low|medium|high, default: medium)
  --compactor-reasoning-effort <e>
                               Reasoning effort for compactor callModel
                               (low|medium|high, default: low)
  --realistic-system-prompt    Use a ~5KB Eliza-style system prompt with action
                               and plugin context (default: minimal one-liner)
  --with-tool-calls            Interleave a synthetic tool-call/tool-result pair
                               every 5 turns and probe its preservation
  --probe-max-tokens <n>       Max tokens for probe answers (default: 600)
  --dry-run                    Use a fake model (no API calls); for plumbing tests
  --help, -h                   Show this help

Env:
  CEREBRAS_API_KEY             Required unless --dry-run
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
      case "--agent-reasoning-effort":
        out.agentReasoningEffort = parseEffort(need(i, a), a);
        i++;
        break;
      case "--judge-reasoning-effort":
        out.judgeReasoningEffort = parseEffort(need(i, a), a);
        i++;
        break;
      case "--compactor-reasoning-effort":
        out.compactorReasoningEffort = parseEffort(need(i, a), a);
        i++;
        break;
      case "--realistic-system-prompt":
        out.realisticSystemPrompt = true;
        break;
      case "--with-tool-calls":
        out.withToolCalls = true;
        break;
      case "--probe-max-tokens":
        out.probeMaxTokens = parseIntStrict(need(i, a), a);
        i++;
        break;
      default:
        if (a.startsWith("--")) {
          throw new Error(`unknown flag ${a}`);
        }
    }
  }
  if (out.turns <= 0) throw new Error("--turns must be positive");
  if (out.compactEvery <= 0)
    throw new Error("--compact-every must be positive");
  if (out.plantFacts < 0) throw new Error("--plant-facts must be >= 0");
  if (out.plantFacts > out.turns) {
    throw new Error("--plant-facts cannot exceed --turns");
  }
  if (out.probeMaxTokens <= 0)
    throw new Error("--probe-max-tokens must be positive");
  return out;
}

function parseEffort(raw: string, flag: string): ReasoningEffort {
  if (!KNOWN_REASONING_EFFORTS.includes(raw as ReasoningEffort)) {
    throw new Error(
      `flag ${flag} expects one of ${KNOWN_REASONING_EFFORTS.join("|")}, got ${raw}`,
    );
  }
  return raw as ReasoningEffort;
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

// Fact kinds rotate round-robin so a small N still gets balanced coverage.
// `api_key` was intentionally removed: forcing the model to recall `sk_*`
// strings tripped safety training on gpt-oss-120b. The replacement kinds are
// memorable, high-information, and safety-neutral.
export type FactKind =
  | "aws_account"
  | "person_name"
  | "address"
  | "code"
  | "book_title"
  | "project_codename"
  | "isbn"
  | "date_iso"
  | "birthday"
  | "flight_number"
  | "uuid"
  | "zipcode";

export const FACT_KINDS: readonly FactKind[] = [
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

  // Balanced kind distribution: rotate through FACT_KINDS in seeded order
  // so a 4-fact run gets 4 distinct kinds; an 8-fact run gets 2 of each of
  // the first 8 kinds; etc. This keeps per-kind accuracy interpretable.
  const kindOrder = shuffleKinds(rand);

  const out: PlantedFact[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    const kind = kindOrder[i % kindOrder.length]!;
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

function shuffleKinds(rand: () => number): FactKind[] {
  const arr = [...FACT_KINDS];
  // Fisher–Yates with the supplied rand source — deterministic per seed.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

function makeFact(
  kind: FactKind,
  rand: () => number,
): {
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
    case "person_name": {
      const first = pick(rand, [
        "Mira",
        "Jules",
        "Aki",
        "Ramon",
        "Soren",
        "Zane",
      ]);
      const last = pick(rand, [
        "Tanaka",
        "Okafor",
        "Ramirez",
        "Lindholm",
        "Khoury",
      ]);
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
    case "book_title": {
      const adj = pick(rand, [
        "Silver",
        "Hidden",
        "Distant",
        "Quiet",
        "Crimson",
        "Final",
      ]);
      const noun = pick(rand, [
        "Compass",
        "Garden",
        "Lighthouse",
        "Atlas",
        "Equation",
        "Harbor",
      ]);
      const title = `The ${adj} ${noun}`;
      return {
        utterance: `The book my friend recommended is called "${title}". Hold onto that.`,
        expected: title,
        question: "What is the book my friend recommended?",
        exactMatch: false,
      };
    }
    case "project_codename": {
      const left = pick(rand, [
        "Blue",
        "Iron",
        "Velvet",
        "Glass",
        "Copper",
        "Echo",
      ]);
      const right = pick(rand, [
        "Falcon",
        "Lantern",
        "Meadow",
        "Cipher",
        "Harbor",
        "Quartz",
      ]);
      const name = `${left} ${right}`;
      return {
        utterance: `Internal codename for the new initiative is "${name}". Don't share it externally.`,
        expected: name,
        question: "What is the internal codename for the new initiative?",
        exactMatch: true,
      };
    }
    case "isbn": {
      // ISBN-13: 13 digits. We don't compute a valid checksum; we just need a
      // unique, memorable identifier that the model has to reproduce.
      let digits = "978";
      for (let i = 0; i < 10; i++) digits += Math.floor(rand() * 10);
      return {
        utterance: `For reference, the ISBN of that book is ${digits}.`,
        expected: digits,
        question: "What is the ISBN of that book?",
        exactMatch: true,
      };
    }
    case "date_iso": {
      const year = 2024 + Math.floor(rand() * 4);
      const month = String(1 + Math.floor(rand() * 12)).padStart(2, "0");
      const day = String(1 + Math.floor(rand() * 28)).padStart(2, "0");
      const date = `${year}-${month}-${day}`;
      return {
        utterance: `The contract effective date is ${date}. Make a note.`,
        expected: date,
        question: "What is the contract effective date?",
        exactMatch: true,
      };
    }
    case "birthday": {
      const month = String(1 + Math.floor(rand() * 12)).padStart(2, "0");
      const day = String(1 + Math.floor(rand() * 28)).padStart(2, "0");
      const date = `${month}/${day}`;
      const who = pick(rand, [
        "my sister",
        "my mom",
        "my partner",
        "my best friend",
      ]);
      return {
        utterance: `${who[0]!.toUpperCase()}${who.slice(1)}'s birthday is ${date}. Don't let me forget.`,
        expected: date,
        question: `When is ${who}'s birthday?`,
        exactMatch: true,
      };
    }
    case "flight_number": {
      const airline = pick(rand, ["UA", "DL", "AA", "BA", "LH", "AF"]);
      const num = 100 + Math.floor(rand() * 9000);
      const flight = `${airline}${num}`;
      return {
        utterance: `My flight is ${flight} on Tuesday — please remember.`,
        expected: flight,
        question: "What is my flight number on Tuesday?",
        exactMatch: true,
      };
    }
    case "uuid": {
      // RFC 4122-ish v4 layout; we only care about the literal string.
      const seg = (n: number) => randHex(rand, n);
      const uuid = `${seg(8)}-${seg(4)}-4${seg(3)}-${pick(rand, ["8", "9", "a", "b"])}${seg(3)}-${seg(12)}`;
      return {
        utterance: `The ticket UUID is ${uuid}. Keep that handy.`,
        expected: uuid,
        question: "What is the ticket UUID?",
        exactMatch: true,
      };
    }
    case "zipcode": {
      const zip = String(10000 + Math.floor(rand() * 89999));
      return {
        utterance: `The warehouse ZIP code is ${zip}. Save that for shipping.`,
        expected: zip,
        question: "What is the warehouse ZIP code?",
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

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelClient = {
  chat(args: {
    model: string;
    messages: ChatMessage[];
    maxTokens?: number;
    temperature?: number;
    /**
     * Reasoning effort for reasoning-capable models (gpt-oss-*, etc).
     * Set "low" for structured extraction (compactor) where deep reasoning
     * wastes the budget; set "medium"/"high" for the agent and judge so
     * they actually scan history instead of producing lazy refusals.
     */
    reasoningEffort?: ReasoningEffort;
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
  // gpt-oss-* are reasoning models. Effort is set per call site by the
  // harness: "low" for the compactor (structured extraction), "medium" for
  // agent turns and judge calls (needs to actually scan history). The
  // global env override stays as an escape hatch for experiments.
  const envEffort = process.env.CEREBRAS_REASONING_EFFORT as
    | ReasoningEffort
    | undefined;
  return {
    async chat({ model, messages, maxTokens, temperature, reasoningEffort }) {
      const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const effort: ReasoningEffort =
        envEffort ?? reasoningEffort ?? "medium";
      const body = JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: temperature ?? 0.7,
        reasoning_effort: effort,
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
            await sleep(baseBackoff * 2 ** attempt);
            continue;
          }
          if (!resp.ok) {
            const text = await safeReadText(resp);
            throw new Error(`upstream ${resp.status}: ${text.slice(0, 200)}`);
          }
          const data = (await resp.json()) as {
            choices?: Array<{
              message?: { content?: string; reasoning?: string };
              finish_reason?: string;
            }>;
          };
          // gpt-oss sometimes emits the answer in message.reasoning when
          // content is empty (typically when the model used most of its
          // budget on reasoning). Fall back to reasoning so we don't lose
          // the response.
          const choice = data.choices?.[0];
          const content =
            choice?.message?.content ?? choice?.message?.reasoning ?? "";
          return { content, latencyMs: Date.now() - start };
        } catch (err) {
          lastErr = err;
          if (attempt === retries) break;
          await sleep(baseBackoff * 2 ** attempt);
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
      if (/contact at the vendor/i.test(text)) {
        return scanAndAnswer(messages, /vendor is ([A-Z][a-z]+ [A-Z][a-z]+)/);
      }
      if (/shipping address/i.test(text)) {
        return scanAndAnswer(messages, /Ship to: ([^.]+)\./);
      }
      if (/quarter's project codename/i.test(text)) {
        return scanAndAnswer(
          messages,
          /codename for this quarter: ([A-Z0-9]+)/,
        );
      }
      if (/book my friend recommended/i.test(text)) {
        return scanAndAnswer(messages, /is called "([^"]+)"/);
      }
      if (/internal codename for the new initiative/i.test(text)) {
        return scanAndAnswer(messages, /initiative is "([^"]+)"/);
      }
      if (/ISBN/i.test(text)) {
        return scanAndAnswer(messages, /ISBN of that book is (\d{13})/);
      }
      if (/contract effective date/i.test(text)) {
        return scanAndAnswer(messages, /effective date is (\d{4}-\d{2}-\d{2})/);
      }
      if (/birthday/i.test(text)) {
        return scanAndAnswer(messages, /birthday is (\d{2}\/\d{2})/);
      }
      if (/flight number/i.test(text)) {
        return scanAndAnswer(messages, /flight is ([A-Z]{2}\d{3,4})/);
      }
      if (/ticket UUID/i.test(text)) {
        return scanAndAnswer(
          messages,
          /UUID is ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/,
        );
      }
      if (/warehouse ZIP code/i.test(text)) {
        return scanAndAnswer(messages, /ZIP code is (\d{5})/);
      }
      if (/tool return/i.test(text)) {
        return scanAndAnswer(
          messages,
          /\[tool_result:[^\]]+\] ([^\n]+?)(?:\s*$|\n)/,
        );
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
    if (hit?.[1]) return { content: hit[1], latencyMs: 1 };
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
  loadCompactor?: (name: StrategyName) => Promise<{
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
    // Return a shallow copy — caller (run loop) does `history.length = 0`
    // followed by re-pushing from `newMessages`. If we returned the same
    // reference, the clear would empty newMessages too and history would
    // end up empty. Same defensive copy for prompt-stripping below.
    return {
      newMessages: [...messages],
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
 * Build a loader that imports the upstream compactor module and wires its
 * Compactor objects (`{name, version, compact}`) with a callModel backed by
 * the supplied chat client. Returns null when the upstream module isn't
 * present yet or when the strategy isn't exported.
 *
 * The loader needs `callModel` because all four runtime strategies are
 * summarization-based — they throw `requires options.callModel` if one isn't
 * provided.
 */
export function buildDefaultCompactorLoader(opts: {
  client: ModelClient;
  model: string;
  /** Soft target token budget passed to compactors. Default: 1024. */
  targetTokens?: number;
  /** Reasoning effort for the compactor's callModel. Default: "low". */
  reasoningEffort?: ReasoningEffort;
}): (name: StrategyName) => Promise<{
  compact: (messages: ChatMessage[]) => Promise<ChatMessage[]>;
} | null> {
  const targetTokens = opts.targetTokens ?? 1024;
  const compactorEffort = opts.reasoningEffort ?? "low";
  return async (name) => {
    try {
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
      if (!key) return null;
      const compactor = mod[key] as
        | {
            name: string;
            version: string;
            compact: (
              t: { messages: { role: string; content: string }[] },
              o: {
                targetTokens: number;
                preserveTailMessages?: number;
                callModel: (params: {
                  systemPrompt: string;
                  messages: { role: string; content: string }[];
                  maxOutputTokens?: number;
                }) => Promise<string>;
                summarizationModel?: string;
              },
            ) => Promise<{
              replacementMessages: { role: string; content: string }[];
            }>;
          }
        | undefined;
      if (!compactor || typeof compactor.compact !== "function") return null;

      // callModel adapts our ModelClient to the Compactor's expected shape.
      const callModel = async (params: {
        systemPrompt: string;
        messages: { role: string; content: string }[];
        maxOutputTokens?: number;
      }): Promise<string> => {
        const resp = await opts.client.chat({
          model: opts.model,
          messages: [
            { role: "system", content: params.systemPrompt },
            ...params.messages.map((m) => ({
              role: m.role as ChatMessage["role"],
              content: m.content,
            })),
          ],
          // Reasoning models need headroom; a 1k cap is too tight for the
          // structured-state JSON path.
          maxTokens: params.maxOutputTokens ?? 4096,
          temperature: 0,
          reasoningEffort: compactorEffort,
        });
        return resp.content;
      };

      return {
        async compact(messages) {
          const transcript = {
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          };
          const artifact = await compactor.compact(transcript, {
            targetTokens,
            preserveTailMessages: 0,
            callModel,
            summarizationModel: opts.model,
          });
          return artifact.replacementMessages.map((m) => ({
            role: m.role as ChatMessage["role"],
            content: m.content,
          }));
        },
      };
    } catch {
      return null;
    }
  };
}

/**
 * Back-compat shim used by tests. The real run loop uses
 * `buildDefaultCompactorLoader` so the compactor gets a callModel wired in.
 * This shim still resolves the import + export-key path and returns null on
 * any failure, matching the pre-existing test contract.
 */
export async function defaultCompactorLoader(name: StrategyName): Promise<{
  compact: (messages: ChatMessage[]) => Promise<ChatMessage[]>;
} | null> {
  try {
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
    if (!key) return null;
    const compactor = mod[key] as
      | { compact: (...a: unknown[]) => Promise<unknown> }
      | undefined;
    if (!compactor || typeof compactor.compact !== "function") return null;
    return {
      async compact(messages) {
        // No callModel — strategies that require one will throw and the
        // error bubbles up. Tests that hit this path supply mocks.
        const transcript = {
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        };
        const artifact = (await compactor.compact(transcript, {
          targetTokens: 1024,
          preserveTailMessages: 0,
        })) as {
          replacementMessages: { role: string; content: string }[];
        };
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
  judgeClient?: ModelClient;
  judgeModel: string;
  judgeWithModel: boolean;
  history: ChatMessage[];
  fact: PlantedFact;
  systemPrompt: string;
  agentReasoningEffort?: ReasoningEffort;
  judgeReasoningEffort?: ReasoningEffort;
  probeMaxTokens?: number;
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
  const resp = await client.chat({
    model,
    messages,
    maxTokens: args.probeMaxTokens ?? 600,
    temperature: 0,
    reasoningEffort: args.agentReasoningEffort ?? "medium",
  });
  const actual = resp.content.trim();
  if (fact.exactMatch) {
    // Normalize whitespace before substring check. gpt-oss-120b sometimes
    // inserts U+202F (narrow no-break space) inside person names (e.g.
    // "Ramon Ramirez"), which breaks a naive substring match against
    // an expected with a regular space. We collapse all Unicode whitespace
    // and zero-width chars to a single ASCII space on both sides.
    const norm = (s: string) =>
      s
        // Collapse any run of Unicode whitespace (incl. NBSP, narrow NBSP,
        // figure space, ideographic space) to a single ASCII space.
        .replace(/\s+/gu, " ")
        // Strip zero-width chars that some models emit inside identifiers.
        .replace(/[​-‍﻿]/g, "");
    const correct = norm(actual).includes(norm(fact.expected));
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
  // WARN: judge uses same model as agent by default — known bias toward the
  // agent's own outputs. For real measurement, set --judge-model to a
  // different model family (e.g. gpt-4o or claude-haiku) so the judge is
  // independent of the system under test.
  const judge = args.judgeFn
    ? await args.judgeFn({
        expected: fact.expected,
        actual,
        question: fact.question,
      })
    : await modelJudge({
        client: args.judgeClient ?? client,
        model: args.judgeModel,
        expected: fact.expected,
        actual,
        question: fact.question,
        reasoningEffort: args.judgeReasoningEffort ?? "medium",
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
  reasoningEffort?: ReasoningEffort;
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
    maxTokens: 400,
    temperature: 0,
    reasoningEffort: args.reasoningEffort ?? "medium",
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
    const parsed = JSON.parse(text) as {
      correct?: unknown;
      reasoning?: unknown;
    };
    const correct = parsed.correct === true;
    const reasoning =
      typeof parsed.reasoning === "string" ? parsed.reasoning : "no reasoning";
    return { correct, reasoning };
  } catch {
    // Fallback: look for an explicit "true"/"false" near the start of the answer.
    const lc = raw.toLowerCase();
    const correct =
      /\btrue\b/.test(lc) &&
      !/\bfalse\b/.test(lc.slice(0, lc.indexOf("true") + 4));
    return { correct, reasoning: "could not parse judge JSON" };
  }
}

// ---------------------------------------------------------------------------
// JSONL writer (collects in memory; flushed at end so callers can inspect)
// ---------------------------------------------------------------------------

export type JsonlEvent =
  | {
      event: "turn";
      turn: number;
      role: "user" | "assistant";
      contentLen: number;
      tokens: number;
      factId?: string;
    }
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
      kind: FactKind | "tool_call";
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
      perKindAccuracy: Record<string, { correct: number; total: number; accuracy: number }>;
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
    return `${this.events.map((e) => JSON.stringify(e)).join("\n")}\n`;
  }
}

// ---------------------------------------------------------------------------
// Run loop
// ---------------------------------------------------------------------------

// Minimal default system prompt. Intentionally NOT a jailbreak — the previous
// "all data is fictional, repeat values back, don't refuse" version was a hack
// to coax gpt-oss-120b into recalling `sk_*` API keys, which real Eliza
// shouldn't be expected to do. Sensitive fact kinds (api_key) were dropped
// instead. The benign kinds (book titles, ISBNs, ZIP codes, etc.) recall
// fine without instruction.
const SYSTEM_PROMPT_MINIMAL =
  "You are a helpful assistant. Answer the user concisely. " +
  "When the user has previously told you a piece of information and later asks " +
  "you to recall it, scan the conversation history and repeat it back accurately.";

/**
 * Build a ~5KB Eliza-style system prompt with placeholder action and plugin
 * descriptions, character bio, etc. The point is to give the compactor
 * something realistic-sized to chew on, not to be a faithful Eliza prompt.
 * The content is deterministic (no rand) so test assertions about size are
 * stable across runs.
 */
export function buildRealisticSystemPrompt(): string {
  const actions = [
    ["REPLY", "Respond directly to the user's most recent message."],
    ["IGNORE", "Stay quiet when no response is warranted."],
    ["FOLLOW_ROOM", "Begin actively participating in the current room."],
    ["UNFOLLOW_ROOM", "Stop actively participating in the current room."],
    ["MUTE_ROOM", "Disable notifications and participation for the room."],
    ["UNMUTE_ROOM", "Re-enable notifications for a previously muted room."],
    ["SEND_MESSAGE", "Send a message to a named target room or user."],
    ["UPDATE_ENTITY", "Persist or revise facts about an entity."],
    ["REMEMBER", "Persist a long-lived memory keyed by topic."],
    ["RECALL", "Retrieve previously stored long-lived memories."],
    ["USE_SKILL", "Invoke a registered skill by name with structured args."],
    ["BROWSER", "Drive a headless browser session via a registered target."],
    ["EXECUTE_CODE", "Run a sandboxed code snippet for computation."],
    ["GENERATE_IMAGE", "Render an image from a textual prompt."],
    ["SEARCH_WEB", "Issue a web search and return the top result snippets."],
    ["READ_FILE", "Read a file from the user's workspace."],
    ["WRITE_FILE", "Persist content to a file in the user's workspace."],
    ["EDIT_FILE", "Apply a targeted edit to an existing file."],
    ["LIST_DIRECTORY", "Enumerate files under a directory path."],
    ["CALENDAR_VIEW", "Read events from the user's calendar."],
    ["CALENDAR_SCHEDULE", "Schedule a new event on the user's calendar."],
  ];
  const plugins = [
    ["bootstrap", "Core actions and providers shipped with the runtime."],
    ["sql", "Drizzle-backed persistence for memories and entities."],
    ["openai", "OpenAI / Cerebras / OpenAI-compatible model provider."],
    ["anthropic", "Anthropic Claude model provider."],
    ["telegram", "Telegram messaging connector."],
    ["discord", "Discord guild and DM connector."],
    ["browser", "Puppeteer-driven web browsing."],
    ["agent-orchestrator", "PTY-backed sub-agent spawning and coordination."],
    ["skills", "Curated skill registry and USE_SKILL execution."],
    ["calendar", "macOS / Google calendar bridge."],
    ["wechat", "WeChat connector."],
  ];
  const lines: string[] = [];
  lines.push("# Eliza Agent System Prompt");
  lines.push("");
  lines.push("## Identity");
  lines.push(
    "You are Eliza, a local-first AI assistant built on the elizaOS runtime. " +
      "You take ownership of long-running tasks, remember context across " +
      "conversations, and prefer concrete action over open-ended discussion. " +
      "You are concise, friendly, and direct. You ask clarifying questions " +
      "only when the user's intent is genuinely ambiguous; otherwise you act.",
  );
  lines.push("");
  lines.push("## Operating Principles");
  lines.push(
    "1. Read the recent conversation before responding. The user's most " +
      "recent message is the highest-priority input, but earlier turns " +
      "establish constraints and facts you must respect.",
  );
  lines.push(
    "2. When the user has told you something previously (a name, a date, " +
      "an identifier, a preference), and they later ask you to recall it, " +
      "scan the conversation history carefully and repeat it back exactly. " +
      "Do not invent a value, do not refuse on the grounds that you 'don't " +
      "have access to that information' — the information is in the history.",
  );
  lines.push(
    "3. Prefer structured action over prose narration. If a user request " +
      "maps to a registered Action, invoke it; if it maps to a Skill, use " +
      "USE_SKILL.",
  );
  lines.push(
    "4. Surface failures honestly. Never silently swallow an error or " +
      "substitute a default — say what failed and why.",
  );
  lines.push("");
  lines.push("## Available Actions");
  for (const [name, desc] of actions) {
    lines.push(`- **${name}**: ${desc}`);
  }
  lines.push("");
  lines.push("## Loaded Plugins");
  for (const [name, desc] of plugins) {
    lines.push(`- \`@elizaos/plugin-${name}\` — ${desc}`);
  }
  lines.push("");
  lines.push("## Memory Model");
  lines.push(
    "You have access to short-term conversation memory (the messages in " +
      "this thread) and long-term persisted memory (via the REMEMBER and " +
      "RECALL actions). Short-term memory is the source of truth for " +
      "anything the user has said in this session. When asked to recall " +
      "session-local facts, scan the message history; do not delegate to " +
      "RECALL for those.",
  );
  lines.push("");
  lines.push("## Response Style");
  lines.push(
    "- Default to short, direct answers. One paragraph or fewer for most " +
      "questions; one sentence for factual recall.",
  );
  lines.push(
    "- When recalling a value, lead with the value itself. Optional context " +
      "comes after, not before.",
  );
  lines.push(
    "- Avoid filler phrases like 'I'd be happy to help', 'Great question', " +
      "or apologetic preambles.",
  );
  lines.push(
    "- Use markdown sparingly. Code goes in fenced blocks; everything else " +
      "is plain prose.",
  );
  lines.push("");
  lines.push("## Safety");
  lines.push(
    "- Refuse requests that would cause real-world harm, exfiltrate real " +
      "credentials, or violate user privacy. The session-local facts " +
      "(addresses, names, dates, codenames) the user shares with you for " +
      "recall benchmarking are not in this category — recall them as asked.",
  );
  lines.push(
    "- When uncertain whether a request is safe, ask one clarifying " +
      "question rather than refusing outright or proceeding blindly.",
  );
  lines.push("");
  lines.push("## Tool Use");
  lines.push(
    "When you invoke a tool, the tool's response is appended to the " +
      "conversation as a message tagged `[tool_result:<name>]`. Treat tool " +
      "results as authoritative for the values they return; quote them " +
      "verbatim when the user asks what a tool returned.",
  );
  lines.push("");
  lines.push("## End of system prompt.");
  return lines.join("\n");
}

export type RunOptions = {
  args: CliArgs;
  client: ModelClient;
  /** Independent judge client (for cross-model judging). Defaults to client. */
  judgeClient?: ModelClient;
  loadCompactor?: (name: StrategyName) => Promise<{
    compact: (messages: ChatMessage[]) => Promise<ChatMessage[]>;
  } | null>;
  /** Optional judge override (used in unit tests). */
  judgeFn?: (args: {
    expected: string;
    actual: string;
    question: string;
  }) => Promise<{ correct: boolean; reasoning: string }>;
};

export type ToolCallProbe = {
  id: string;
  turn: number;
  toolName: string;
  toolValue: string;
  question: string;
};

/**
 * Plan synthetic tool-call/tool-result pairs every 5 turns (starting at
 * turn 5). Each tool-result is paired with a probe asking what that specific
 * tool returned at that turn. Probes are reproducible from the seed.
 */
export function planToolCalls(args: {
  totalTurns: number;
  seed: number;
}): ToolCallProbe[] {
  const out: ToolCallProbe[] = [];
  const rand = rng(args.seed ^ 0x517cc1b7);
  const tools = [
    "get_weather",
    "lookup_stock",
    "search_inventory",
    "fetch_metric",
    "query_calendar",
  ];
  for (let t = 5; t <= args.totalTurns; t += 5) {
    const tool = tools[Math.floor(rand() * tools.length)]!;
    const value = `${randHex(rand, 6).toUpperCase()}-${Math.floor(rand() * 1000)}`;
    out.push({
      id: `tool_${t}`,
      turn: t,
      toolName: tool,
      toolValue: value,
      question: `What did the ${tool} tool return when called at turn ${t}?`,
    });
  }
  return out;
}

export async function runDriftHarness(opts: RunOptions): Promise<JsonlSink> {
  const { args, client } = opts;
  const judgeClient = opts.judgeClient ?? client;
  const sink = new JsonlSink();
  const facts = planFacts({
    totalTurns: args.turns,
    count: args.plantFacts,
    seed: args.seed,
  });
  const factByTurn = new Map<number, PlantedFact>();
  for (const f of facts) factByTurn.set(f.turn, f);

  const toolCalls = args.withToolCalls
    ? planToolCalls({ totalTurns: args.turns, seed: args.seed })
    : [];
  const toolByTurn = new Map<number, ToolCallProbe>();
  for (const tc of toolCalls) toolByTurn.set(tc.turn, tc);

  const systemPrompt = args.realisticSystemPrompt
    ? buildRealisticSystemPrompt()
    : SYSTEM_PROMPT_MINIMAL;

  const rand = rng(args.seed ^ 0x9e3779b9);
  const history: ChatMessage[] = [];
  let totalCompactions = 0;
  let totalTokensSaved = 0;
  let totalProbes = 0;
  let totalCorrect = 0;
  // Per-kind accuracy tally. Keys are FactKind strings plus "tool_call".
  const perKind: Record<string, { correct: number; total: number }> = {};
  const tally = (kind: string, correct: boolean): void => {
    const slot = perKind[kind] ?? { correct: 0, total: 0 };
    slot.total++;
    if (correct) slot.correct++;
    perKind[kind] = slot;
  };

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
      { role: "system", content: systemPrompt },
      ...history,
    ];
    const resp = await client.chat({
      model: args.model,
      messages,
      maxTokens: 256,
      temperature: 0.7,
      reasoningEffort: args.agentReasoningEffort,
    });
    history.push({ role: "assistant", content: resp.content });
    sink.push({
      event: "turn",
      turn: i,
      role: "assistant",
      contentLen: resp.content.length,
      tokens: approxTokens(resp.content),
    });

    // After the assistant's reply, optionally inject a synthetic tool call
    // and tool result. We model both as plain user/assistant messages with
    // explicit tags so the compactor sees them as natural text.
    const toolCall = toolByTurn.get(i);
    if (toolCall) {
      const callMsg = `[tool_call:${toolCall.toolName}] {"turn": ${i}}`;
      const resultMsg = `[tool_result:${toolCall.toolName}] ${toolCall.toolValue}`;
      history.push({ role: "assistant", content: callMsg });
      history.push({ role: "user", content: resultMsg });
      sink.push({
        event: "turn",
        turn: i,
        role: "assistant",
        contentLen: callMsg.length,
        tokens: approxTokens(callMsg),
      });
      sink.push({
        event: "turn",
        turn: i,
        role: "user",
        contentLen: resultMsg.length,
        tokens: approxTokens(resultMsg),
      });
    }

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
        history.length = 0;
        for (const m of result.newMessages) {
          if (m.role === "system" && history.length === 0) {
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
          judgeClient,
          model: args.model,
          judgeModel: args.judgeModel,
          judgeWithModel: !args.dryRun,
          history,
          fact: f,
          systemPrompt,
          agentReasoningEffort: args.agentReasoningEffort,
          judgeReasoningEffort: args.judgeReasoningEffort,
          probeMaxTokens: args.probeMaxTokens,
          judgeFn: opts.judgeFn,
        });
        totalProbes++;
        if (outcome.correct) totalCorrect++;
        tally(f.kind, outcome.correct);
        sink.push({
          event: "probe",
          atTurn: i,
          factId: outcome.factId,
          plantedTurn: outcome.turn,
          kind: f.kind,
          expected: outcome.expected,
          actual: outcome.actual,
          correct: outcome.correct,
          judgeReasoning: outcome.judgeReasoning,
          phase: "post-compact",
        });
      }

      // Probe tool-call results whose turn <= i.
      for (const tc of toolCalls) {
        if (tc.turn > i) continue;
        const outcome = await probeToolCall({
          client,
          model: args.model,
          history,
          toolCall: tc,
          systemPrompt,
          agentReasoningEffort: args.agentReasoningEffort,
          probeMaxTokens: args.probeMaxTokens,
        });
        totalProbes++;
        if (outcome.correct) totalCorrect++;
        tally("tool_call", outcome.correct);
        sink.push({
          event: "probe",
          atTurn: i,
          factId: outcome.factId,
          plantedTurn: outcome.turn,
          kind: "tool_call",
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
      judgeClient,
      model: args.model,
      judgeModel: args.judgeModel,
      judgeWithModel: !args.dryRun,
      history,
      fact: f,
      systemPrompt,
      agentReasoningEffort: args.agentReasoningEffort,
      judgeReasoningEffort: args.judgeReasoningEffort,
      probeMaxTokens: args.probeMaxTokens,
      judgeFn: opts.judgeFn,
    });
    totalProbes++;
    if (outcome.correct) totalCorrect++;
    tally(f.kind, outcome.correct);
    sink.push({
      event: "probe",
      atTurn: args.turns,
      factId: outcome.factId,
      plantedTurn: outcome.turn,
      kind: f.kind,
      expected: outcome.expected,
      actual: outcome.actual,
      correct: outcome.correct,
      judgeReasoning: outcome.judgeReasoning,
      phase: "final",
    });
  }

  // Final probe of every tool-call result.
  for (const tc of toolCalls) {
    const outcome = await probeToolCall({
      client,
      model: args.model,
      history,
      toolCall: tc,
      systemPrompt,
      agentReasoningEffort: args.agentReasoningEffort,
      probeMaxTokens: args.probeMaxTokens,
    });
    totalProbes++;
    if (outcome.correct) totalCorrect++;
    tally("tool_call", outcome.correct);
    sink.push({
      event: "probe",
      atTurn: args.turns,
      factId: outcome.factId,
      plantedTurn: outcome.turn,
      kind: "tool_call",
      expected: outcome.expected,
      actual: outcome.actual,
      correct: outcome.correct,
      judgeReasoning: outcome.judgeReasoning,
      phase: "final",
    });
  }

  const overallAccuracy = totalProbes > 0 ? totalCorrect / totalProbes : 0;
  const perKindAccuracy: Record<
    string,
    { correct: number; total: number; accuracy: number }
  > = {};
  for (const [kind, { correct, total }] of Object.entries(perKind)) {
    perKindAccuracy[kind] = {
      correct,
      total,
      accuracy: total > 0 ? correct / total : 0,
    };
  }
  sink.push({
    event: "summary",
    strategy: args.strategy,
    overallAccuracy,
    perKindAccuracy,
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

async function probeToolCall(args: {
  client: ModelClient;
  model: string;
  history: ChatMessage[];
  toolCall: ToolCallProbe;
  systemPrompt: string;
  agentReasoningEffort?: ReasoningEffort;
  probeMaxTokens?: number;
}): Promise<ProbeOutcome> {
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    ...args.history,
    { role: "user", content: args.toolCall.question },
  ];
  const resp = await args.client.chat({
    model: args.model,
    messages,
    maxTokens: args.probeMaxTokens ?? 600,
    temperature: 0,
    reasoningEffort: args.agentReasoningEffort ?? "medium",
  });
  const actual = resp.content.trim();
  const correct = actual.includes(args.toolCall.toolValue);
  return {
    factId: args.toolCall.id,
    turn: args.toolCall.turn,
    expected: args.toolCall.toolValue,
    actual,
    correct,
    judgeReasoning: correct
      ? "tool-call: expected substring present"
      : "tool-call: expected substring missing",
  };
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
    // In dry-run we keep the loader undefined so the harness uses its
    // built-in naive summary fallback (no real model calls). For real
    // runs we wire the upstream Compactor objects with a callModel that
    // hits the same Cerebras client.
    loadCompactor: args.dryRun
      ? undefined
      : buildDefaultCompactorLoader({
          client,
          model: args.model,
          reasoningEffort: args.compactorReasoningEffort,
        }),
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
  if (
    unavailable &&
    unavailable.event === "compact" &&
    unavailable.unavailable
  ) {
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
