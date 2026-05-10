/**
 * Bun shim invoked by the Python bridge in eliza_compactbench/bridge.py.
 *
 * Protocol:
 *   - argv[2] is the strategy name (e.g. "naive-summary")
 *   - stdin contains a single JSON document:
 *       { strategy, transcript, options }
 *     where `transcript` is either a CompactBench Transcript
 *     ({ turns: [{ id, role, content }] }) or already a
 *     CompactorTranscript ({ messages: [...] }).
 *   - stdout receives a single JSON document representing the
 *     CompactBench `CompactionArtifact` produced by the TS strategy.
 *
 * On error, the shim prints `{"error": "..."}` to stdout and exits 1.
 *
 * The model-call function used by summarization-based strategies hits
 * Cerebras's OpenAI-compatible chat completions endpoint with the
 * `gpt-oss-120b` model (see CEREBRAS_API_KEY env var).
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ---------------------------------------------------------------------------
// Lazy strategy resolution. The TS compactor module may not exist yet.
// ---------------------------------------------------------------------------

const COMPACTOR_MODULE = resolvePath(
  import.meta.dir,
  "../../../../packages/agent/src/runtime/conversation-compactor.ts",
);

const STRATEGY_EXPORTS: Record<string, string> = {
  "naive-summary": "naiveSummaryCompactor",
  "structured-state": "structuredStateCompactor",
  "hierarchical-summary": "hierarchicalSummaryCompactor",
  "hybrid-ledger": "hybridLedgerCompactor",
};

// ---------------------------------------------------------------------------
// Cerebras model-call wired through to summarization-based compactors.
// ---------------------------------------------------------------------------

type CompactorMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
};

const CEREBRAS_BASE_URL =
  process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1";
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";

async function cerebrasChat(params: {
  systemPrompt: string;
  messages: CompactorMessage[];
  maxOutputTokens?: number;
}): Promise<string> {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "CEREBRAS_API_KEY is not set; summarization-based compactors cannot run.",
    );
  }

  const messages: { role: string; content: string }[] = [];
  if (params.systemPrompt) {
    messages.push({ role: "system", content: params.systemPrompt });
  }
  for (const m of params.messages) {
    // Cerebras's OpenAI-compat surface accepts user/assistant/system/tool.
    messages.push({ role: m.role, content: m.content });
  }

  // gpt-oss-120b is a reasoning model. Without `reasoning_effort:"low"`
  // it spends most of its token budget on internal reasoning tokens and
  // routinely hits finish_reason:"length" before producing visible content.
  // For compaction work — extract facts, write a summary — there's no deep
  // reasoning required, so "low" is the right default.
  //
  // Token budget: hierarchical-summary's rollup phase folds many chunk
  // summaries into one. Honor the caller's maxOutputTokens but bump the
  // floor so a request for "1500 target tokens" doesn't truncate a
  // multi-chunk rollup mid-sentence.
  const callerMax = params.maxOutputTokens;
  const maxOutputTokens =
    typeof callerMax === "number" && callerMax > 0
      ? Math.max(callerMax, 4096)
      : 8192;
  const body = {
    model: CEREBRAS_MODEL,
    messages,
    temperature: 0,
    max_tokens: maxOutputTokens,
    reasoning_effort: process.env.CEREBRAS_REASONING_EFFORT ?? "low",
  };

  const res = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Cerebras chat completion failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  const json = (await res.json()) as {
    choices?: {
      message?: { content?: string; reasoning?: string };
      finish_reason?: string;
    }[];
  };
  const choice = json.choices?.[0];
  // gpt-oss-120b on Cerebras returns the visible answer in message.content
  // when present, but for short responses the model sometimes routes the
  // entire answer through message.reasoning with no separate content.
  // Prefer content; fall back to reasoning so we don't lose the response.
  const text = choice?.message?.content || choice?.message?.reasoning;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error(
      `Cerebras chat completion returned no text (finish_reason=${choice?.finish_reason}): ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// Transcript adapters: CompactBench <-> elizaOS Compactor types.
// ---------------------------------------------------------------------------

type CompactBenchTurn = {
  id: number;
  role: "system" | "user" | "assistant";
  content: string;
  tags?: string[];
};

type CompactBenchTranscript = {
  turns: CompactBenchTurn[];
  metadata?: Record<string, unknown>;
};

type ElizaTranscript = {
  messages: CompactorMessage[];
  metadata?: Record<string, unknown>;
};

const ALLOWED_ROLES: ReadonlySet<CompactorMessage["role"]> = new Set([
  "system",
  "user",
  "assistant",
  "tool",
]);

function coerceRole(role: unknown): CompactorMessage["role"] {
  if (typeof role === "string" && ALLOWED_ROLES.has(role as CompactorMessage["role"])) {
    return role as CompactorMessage["role"];
  }
  // Unknown roles get coerced to "user" rather than silently producing an
  // invalid message; the compactor expects the union and a wrong role
  // would be dropped by downstream filters.
  return "user";
}

function toElizaTranscript(input: unknown): ElizaTranscript {
  if (input && typeof input === "object") {
    if (Array.isArray((input as ElizaTranscript).messages)) {
      const t = input as ElizaTranscript;
      return {
        messages: t.messages.map((m) => ({
          ...m,
          role: coerceRole(m.role),
          content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
        })),
        metadata: t.metadata,
      };
    }
    if (Array.isArray((input as CompactBenchTranscript).turns)) {
      const cb = input as CompactBenchTranscript;
      const turns = cb.turns;
      const baseMetadata: Record<string, unknown> = {
        source: "compactbench",
        turnIds: turns.map((t) => t.id),
      };
      // Forward any caller-provided metadata (priorLedger for drift
      // cycles, scenario tags, etc). Caller wins on key collision so we
      // never overwrite priorLedger with the auto-generated source tag.
      const metadata =
        cb.metadata && typeof cb.metadata === "object"
          ? { ...baseMetadata, ...cb.metadata }
          : baseMetadata;
      return {
        messages: turns.map((t) => ({
          role: coerceRole(t.role),
          content: t.content,
          tags: t.tags,
        })),
        metadata,
      };
    }
  }
  throw new Error(
    `Transcript must be a Compactor- or CompactBench-shaped object; got ${typeof input}`,
  );
}

function toCompactBenchArtifact(
  artifact: {
    replacementMessages: CompactorMessage[];
    stats: { latencyMs: number; summarizationModel?: string; extra?: Record<string, unknown> };
  },
  strategyName: string,
  strategyVersion: string,
  transcript: ElizaTranscript,
): Record<string, unknown> {
  // Concatenate replacement messages into a single summary blob; structured
  // state extraction is the strategy's job and is forwarded under
  // method_metadata until the TS strategies emit the six-section shape
  // natively. The CompactionArtifact contract caps summaryText at 8000
  // chars — pydantic will reject longer strings.
  const summaryText = artifact.replacementMessages
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n")
    .slice(0, 8000);

  const structuredState =
    (artifact.stats.extra?.structuredState as Record<string, unknown> | undefined) ?? {};

  // Surface the source turn ids the compactor preserved when the
  // transcript metadata carries them (CompactBench attaches turnIds in
  // toElizaTranscript). The scoring side may use this for compression
  // ratio and traceability metrics.
  const turnIdsRaw = transcript.metadata?.turnIds;
  const selectedSourceTurnIds: number[] = Array.isArray(turnIdsRaw)
    ? turnIdsRaw.filter((x): x is number => typeof x === "number")
    : [];

  return {
    schemaVersion: "1.0.0",
    summaryText,
    structured_state: {
      immutable_facts: asStringArray(structuredState.immutableFacts),
      locked_decisions: asStringArray(structuredState.lockedDecisions),
      deferred_items: asStringArray(structuredState.deferredItems),
      forbidden_behaviors: asStringArray(structuredState.forbiddenBehaviors),
      entity_map: asStringRecord(structuredState.entityMap),
      unresolved_items: asStringArray(structuredState.unresolvedItems),
    },
    selectedSourceTurnIds,
    warnings: [],
    methodMetadata: {
      method: strategyName,
      method_version: strategyVersion,
      latency_ms: artifact.stats.latencyMs,
      summarization_model: artifact.stats.summarizationModel ?? null,
      replacement_message_count: artifact.replacementMessages.length,
    },
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").slice(0, 200);
}

function asStringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt-stripping passthrough fallback.
// ---------------------------------------------------------------------------

const PROMPT_COMPACTION_MODULE = resolvePath(
  import.meta.dir,
  "../../../../packages/agent/src/runtime/prompt-compaction.ts",
);

async function runPromptStripping(
  transcript: ElizaTranscript,
): Promise<{
  replacementMessages: CompactorMessage[];
  stats: { latencyMs: number; extra?: Record<string, unknown> };
}> {
  const start = Date.now();
  // Best-effort: serialize transcript as a single string and pipe it through
  // any exported `compact*` regex helpers. This is the existing system as a
  // baseline — expected to score badly.
  let mod: Record<string, unknown>;
  try {
    mod = (await import(PROMPT_COMPACTION_MODULE)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Could not load prompt-compaction module: ${(err as Error).message}`,
    );
  }
  let blob = transcript.messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n");
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn === "function" && /^compact[A-Z]/.test(name)) {
      try {
        const next = (fn as (s: string) => string)(blob);
        if (typeof next === "string") blob = next;
      } catch {
        // Stripping helpers must not throw on real transcripts; ignore.
      }
    }
  }
  return {
    replacementMessages: [
      { role: "system", content: blob.slice(0, 16000) },
    ],
    stats: { latencyMs: Date.now() - start },
  };
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const strategyArg = process.argv[2];
  if (!strategyArg) {
    throw new Error("Usage: ts_bridge.ts <strategy>");
  }

  const stdinText = readFileSync(0, "utf-8");
  if (!stdinText.trim()) {
    throw new Error("No payload received on stdin");
  }
  const payload = JSON.parse(stdinText) as {
    strategy?: string;
    transcript?: unknown;
    options?: Record<string, unknown>;
  };
  const strategy = payload.strategy ?? strategyArg;
  if (!payload.transcript) {
    throw new Error("Payload missing 'transcript'");
  }

  const transcript = toElizaTranscript(payload.transcript);
  const options = payload.options ?? {};

  if (strategy === "prompt-stripping-passthrough") {
    const artifact = await runPromptStripping(transcript);
    process.stdout.write(
      JSON.stringify(
        toCompactBenchArtifact(
          { replacementMessages: artifact.replacementMessages, stats: artifact.stats },
          "prompt-stripping-passthrough",
          "0.0.0",
          transcript,
        ),
      ),
    );
    return;
  }

  const exportName = STRATEGY_EXPORTS[strategy];
  if (!exportName) {
    throw new Error(
      `Unknown strategy '${strategy}'. Known: ${Object.keys(STRATEGY_EXPORTS).join(", ")}, prompt-stripping-passthrough`,
    );
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(COMPACTOR_MODULE)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Could not load conversation-compactor module at ${COMPACTOR_MODULE}: ${(err as Error).message}`,
    );
  }

  const impl = mod[exportName] as
    | {
        name: string;
        version: string;
        compact: (
          t: ElizaTranscript,
          opts: Record<string, unknown>,
        ) => Promise<{
          replacementMessages: CompactorMessage[];
          stats: { latencyMs: number; summarizationModel?: string; extra?: Record<string, unknown> };
        }>;
      }
    | undefined;
  if (!impl || typeof impl.compact !== "function") {
    throw new Error(
      `Module ${COMPACTOR_MODULE} does not export a Compactor named '${exportName}'.`,
    );
  }

  const compactorOptions = {
    targetTokens: 1500,
    preserveTailMessages: 6,
    summarizationModel: CEREBRAS_MODEL,
    callModel: cerebrasChat,
    ...options,
  };

  const result = await impl.compact(transcript, compactorOptions);
  process.stdout.write(
    JSON.stringify(
      toCompactBenchArtifact(result, impl.name, impl.version, transcript),
    ),
  );
}

main().catch((err: Error) => {
  // Emit the error envelope on a fresh line so any earlier stray stdout
  // (e.g., bun's import-time warnings) doesn't fuse into the JSON object.
  // The Python bridge scans for the last balanced JSON block on stdout,
  // so this is the recoverable path; exit 1 still signals failure.
  const message = err && err.message ? err.message : String(err);
  process.stdout.write(`\n${JSON.stringify({ error: message })}\n`);
  process.exit(1);
});
