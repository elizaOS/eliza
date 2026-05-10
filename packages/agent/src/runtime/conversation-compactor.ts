/**
 * Conversation-history compactors.
 *
 * Implements the four CompactBench strategies (https://github.com/compactbench/compactbench)
 * — naive-summary, structured-state, hierarchical-summary, hybrid-ledger —
 * against the shared contract in conversation-compactor.types.ts.
 *
 * Distinct from prompt-compaction.ts which strips presentation-layer sections
 * from a single prompt string. This module operates over multi-turn message
 * arrays and uses an LLM to summarize the older portion of the transcript
 * while preserving:
 *   - the system prompt at index 0 (verbatim, never summarized)
 *   - the trailing N messages (default 6) verbatim
 *   - tool_call / tool_result pairing across the boundary
 */

import {
  approxCountTokens,
  type CompactionArtifact,
  type Compactor,
  type CompactorMessage,
  type CompactorModelCall,
  type CompactorOptions,
  type CompactorTranscript,
  countTranscriptTokens,
  type TokenCounter,
} from "./conversation-compactor.types.ts";

// ---------------------------------------------------------------------------
// Boundary helpers
// ---------------------------------------------------------------------------

const DEFAULT_PRESERVE_TAIL = 6;

/**
 * Identify the index that splits compacted-region (indices < boundary) from
 * preserved-tail (indices >= boundary), shifting the boundary outward (toward
 * older messages, i.e. lower indices) until no tool_call / tool_result pair
 * is split across it.
 *
 * Index 0 is reserved when present as a system prompt and is always retained
 * outside the compactable region — callers should treat indices [1, boundary)
 * as the region to summarize.
 *
 * Returns an integer in [systemOffset, messages.length].
 *
 *   - boundary === messages.length  ⇒ nothing to compact (tail covers all).
 *   - boundary <= systemOffset      ⇒ nothing to compact (everything preserved).
 */
export function findSafeCompactionBoundary(
  messages: CompactorMessage[],
  preserveTailMessages: number = DEFAULT_PRESERVE_TAIL,
): number {
  const total = messages.length;
  if (total === 0) return 0;

  const systemOffset = messages[0].role === "system" ? 1 : 0;
  const tail = Math.max(0, preserveTailMessages);

  let boundary = total - tail;
  if (boundary <= systemOffset) {
    return systemOffset;
  }

  // Build an index of tool_call ids → producer index (assistant message that
  // emitted the call). We will then look for tool-role consumers that answer
  // those calls. Any pair (producer, consumer) that straddles the boundary
  // forces the boundary outward (we expand the preserved tail) until both
  // ends are on the same side.
  const callIdToProducer = new Map<string, number>();
  for (let i = 0; i < total; i++) {
    const m = messages[i];
    if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        if (tc.id) callIdToProducer.set(tc.id, i);
      }
    }
  }

  // Index tool-role consumers by their toolCallId.
  const consumersByCallId = new Map<string, number[]>();
  for (let i = 0; i < total; i++) {
    const m = messages[i];
    if (m.role === "tool" && m.toolCallId) {
      const list = consumersByCallId.get(m.toolCallId);
      if (list) list.push(i);
      else consumersByCallId.set(m.toolCallId, [i]);
    }
  }

  // A pair straddles the boundary iff one endpoint is < boundary and the
  // other is >= boundary. Shift boundary down to include the producer.
  // Iterate to convergence — shifting may pull in additional pairs.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [callId, producerIdx] of callIdToProducer) {
      const consumers = consumersByCallId.get(callId) ?? [];
      const indices = [producerIdx, ...consumers];
      const minIdx = Math.min(...indices);
      const maxIdx = Math.max(...indices);
      if (minIdx < boundary && maxIdx >= boundary) {
        // Pair straddles — pull boundary down to include the producer.
        boundary = minIdx;
        changed = true;
      }
    }
    // Also handle orphaned tool-role messages: a consumer whose producer
    // is unknown but whose neighbor preceding-assistant message is across
    // the boundary. If the consumer is preserved (>= boundary) but the
    // immediately-preceding assistant turn is in the compacted region, we
    // pull the boundary down to include that assistant turn so the tail
    // is self-consistent.
    for (let i = boundary; i < total; i++) {
      if (messages[i].role === "tool") {
        // Walk backward to find the nearest assistant.
        for (let j = i - 1; j >= systemOffset; j--) {
          if (messages[j].role === "assistant") {
            if (j < boundary) {
              boundary = j;
              changed = true;
            }
            break;
          }
        }
      }
    }
    if (boundary <= systemOffset) {
      boundary = systemOffset;
      break;
    }
  }

  return boundary;
}

// ---------------------------------------------------------------------------
// Shared compaction utilities
// ---------------------------------------------------------------------------

function getCounter(options: CompactorOptions): TokenCounter {
  return options.countTokens ?? approxCountTokens;
}

function messagesTokens(
  msgs: CompactorMessage[],
  counter: TokenCounter,
): number {
  let total = 0;
  for (const m of msgs) {
    total += counter(m.content);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += counter(tc.name);
        total += counter(JSON.stringify(tc.arguments));
      }
    }
  }
  return total;
}

function renderMessageForSummary(m: CompactorMessage): string {
  const parts: string[] = [];
  parts.push(`[${m.role}]`);
  if (m.toolName) parts.push(`(tool=${m.toolName})`);
  if (m.toolCallId) parts.push(`(answersToolCall=${m.toolCallId})`);
  parts.push(m.content);
  if (m.toolCalls && m.toolCalls.length > 0) {
    for (const tc of m.toolCalls) {
      parts.push(
        `\n  toolCall id=${tc.id} name=${tc.name} args=${JSON.stringify(tc.arguments)}`,
      );
    }
  }
  return parts.join(" ");
}

function renderRegionForPrompt(region: CompactorMessage[]): string {
  return region.map(renderMessageForSummary).join("\n");
}

function requireCallModel(
  options: CompactorOptions,
  strategy: string,
): CompactorModelCall {
  if (!options.callModel) {
    throw new Error(`${strategy} requires options.callModel`);
  }
  return options.callModel;
}

function buildStats(params: {
  original: CompactorTranscript;
  replacement: CompactorMessage[];
  preservedTail: CompactorMessage[];
  systemPrefix: CompactorMessage[];
  options: CompactorOptions;
  startedAt: number;
  extra?: Record<string, unknown>;
}): CompactionArtifact["stats"] {
  const counter = getCounter(params.options);
  const compactedMessages = [
    ...params.systemPrefix,
    ...params.replacement,
    ...params.preservedTail,
  ];
  return {
    originalMessageCount: params.original.messages.length,
    compactedMessageCount: compactedMessages.length,
    originalTokens: countTranscriptTokens(params.original, counter),
    compactedTokens: messagesTokens(compactedMessages, counter),
    summarizationModel: params.options.summarizationModel,
    latencyMs: Date.now() - params.startedAt,
    extra: params.extra,
  };
}

type SplitTranscript = {
  systemPrefix: CompactorMessage[];
  region: CompactorMessage[];
  preservedTail: CompactorMessage[];
};

function splitTranscript(
  transcript: CompactorTranscript,
  preserveTailMessages: number,
): SplitTranscript {
  const messages = transcript.messages;
  const systemOffset = messages[0]?.role === "system" ? 1 : 0;
  const systemPrefix = systemOffset === 1 ? [messages[0]] : [];
  const boundary = findSafeCompactionBoundary(messages, preserveTailMessages);
  const region = messages.slice(systemOffset, boundary);
  const preservedTail = messages.slice(boundary);
  return { systemPrefix, region, preservedTail };
}

// ---------------------------------------------------------------------------
// Strategy: naive-summary
// ---------------------------------------------------------------------------

const NAIVE_SYSTEM_PROMPT =
  "You are a conversation summarizer. Read the supplied transcript and write" +
  " a concise prose summary that preserves: facts established, decisions" +
  " made, pending actions, identifiers, and any tool calls and their" +
  " outcomes. Do not invent details. Do not include meta-commentary.";

async function naiveCompact(
  transcript: CompactorTranscript,
  options: CompactorOptions,
): Promise<CompactionArtifact> {
  const startedAt = Date.now();
  const callModel = requireCallModel(options, "naive-summary");
  const preserveTail = options.preserveTailMessages ?? DEFAULT_PRESERVE_TAIL;
  const { systemPrefix, region, preservedTail } = splitTranscript(
    transcript,
    preserveTail,
  );

  if (region.length === 0) {
    return {
      replacementMessages: [],
      stats: buildStats({
        original: transcript,
        replacement: [],
        preservedTail,
        systemPrefix,
        options,
        startedAt,
        extra: { regionSize: 0 },
      }),
    };
  }

  const userBody = renderRegionForPrompt(region);

  const callOnce = async (extraInstruction?: string): Promise<string> => {
    const sys =
      NAIVE_SYSTEM_PROMPT +
      (extraInstruction
        ? `\n\nAdditional constraint: ${extraInstruction}`
        : "");
    return callModel({
      systemPrompt: sys,
      messages: [
        {
          role: "user",
          content: `Summarize the following conversation:\n\n${userBody}`,
        },
      ],
      maxOutputTokens: options.targetTokens,
    });
  };

  let summary = (await callOnce()).trim();
  let retried = false;
  const counter = getCounter(options);
  if (counter(summary) > options.targetTokens) {
    retried = true;
    summary = (
      await callOnce(
        `Be more concise; the response must fit within ${options.targetTokens} tokens.`,
      )
    ).trim();
  }

  const replacement: CompactorMessage[] = [
    {
      role: "assistant",
      content: `[conversation summary]\n${summary}`,
      tags: ["compactor:naive-summary"],
    },
  ];

  return {
    replacementMessages: replacement,
    stats: buildStats({
      original: transcript,
      replacement,
      preservedTail,
      systemPrefix,
      options,
      startedAt,
      extra: { retried, regionSize: region.length },
    }),
  };
}

export const naiveSummaryCompactor: Compactor = {
  name: "naive-summary",
  version: "1.0.0",
  compact: naiveCompact,
};

// ---------------------------------------------------------------------------
// Strategy: structured-state
// ---------------------------------------------------------------------------

type StructuredState = {
  facts: string[];
  decisions: string[];
  pending_actions: string[];
  entities: Record<string, string>;
};

const STRUCTURED_SYSTEM_PROMPT =
  "You are a conversation state extractor. Read the supplied transcript and" +
  " output a JSON object with exactly these keys:\n" +
  '  - "facts": string[] — durable facts established in the conversation\n' +
  '  - "decisions": string[] — decisions made by the user or agent\n' +
  '  - "pending_actions": string[] — open follow-ups still to be done\n' +
  '  - "entities": object — entity name → short description\n' +
  "Output ONLY the JSON object, no prose, no markdown fences.";

function safeParseStructured(raw: string): StructuredState {
  // Tolerate ```json fences and surrounding prose by extracting the first
  // {...} balanced block. Falls back to an empty state on parse failure.
  const trimmed = raw.trim();
  let body = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) body = fenceMatch[1].trim();
  else {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      body = trimmed.slice(firstBrace, lastBrace + 1);
    }
  }
  const parsed = JSON.parse(body) as Partial<StructuredState>;
  return {
    facts: Array.isArray(parsed.facts) ? parsed.facts.map(String) : [],
    decisions: Array.isArray(parsed.decisions)
      ? parsed.decisions.map(String)
      : [],
    pending_actions: Array.isArray(parsed.pending_actions)
      ? parsed.pending_actions.map(String)
      : [],
    entities:
      parsed.entities && typeof parsed.entities === "object"
        ? Object.fromEntries(
            Object.entries(parsed.entities as Record<string, unknown>).map(
              ([k, v]) => [k, String(v)],
            ),
          )
        : {},
  };
}

function renderStructuredState(state: StructuredState): string {
  const lines: string[] = ["[conversation state]"];
  lines.push("Facts:");
  for (const f of state.facts) lines.push(`- ${f}`);
  lines.push("Decisions:");
  for (const d of state.decisions) lines.push(`- ${d}`);
  lines.push("Pending actions:");
  for (const p of state.pending_actions) lines.push(`- ${p}`);
  lines.push("Entities:");
  for (const [k, v] of Object.entries(state.entities)) {
    lines.push(`- ${k}: ${v}`);
  }
  return lines.join("\n");
}

async function structuredCompact(
  transcript: CompactorTranscript,
  options: CompactorOptions,
): Promise<CompactionArtifact> {
  const startedAt = Date.now();
  const callModel = requireCallModel(options, "structured-state");
  const preserveTail = options.preserveTailMessages ?? DEFAULT_PRESERVE_TAIL;
  const { systemPrefix, region, preservedTail } = splitTranscript(
    transcript,
    preserveTail,
  );

  if (region.length === 0) {
    return {
      replacementMessages: [],
      stats: buildStats({
        original: transcript,
        replacement: [],
        preservedTail,
        systemPrefix,
        options,
        startedAt,
      }),
    };
  }

  const userBody = renderRegionForPrompt(region);
  const raw = await callModel({
    systemPrompt: STRUCTURED_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Extract conversation state from:\n\n${userBody}`,
      },
    ],
    maxOutputTokens: options.targetTokens,
  });

  let state: StructuredState;
  try {
    state = safeParseStructured(raw);
  } catch {
    state = { facts: [], decisions: [], pending_actions: [], entities: {} };
  }

  let rendered = renderStructuredState(state);
  const counter = getCounter(options);

  // If the rendered state still exceeds the budget, recurse on the rendered
  // state itself (treat it as a single fake transcript and re-summarize).
  // Because compactors are content-shaping, recursion bottoms out when a
  // single condensation pass no longer reduces size.
  let recursed = false;
  while (counter(rendered) > options.targetTokens) {
    recursed = true;
    const reduced = await callModel({
      systemPrompt: STRUCTURED_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `Reduce this state to fit within ${options.targetTokens} tokens` +
            ` while preserving the most load-bearing items:\n\n${rendered}`,
        },
      ],
      maxOutputTokens: options.targetTokens,
    });
    let reducedState: StructuredState;
    try {
      reducedState = safeParseStructured(reduced);
    } catch {
      break;
    }
    const next = renderStructuredState(reducedState);
    if (counter(next) >= counter(rendered)) break; // no progress
    state = reducedState;
    rendered = next;
  }

  const replacement: CompactorMessage[] = [
    {
      role: "system",
      content: rendered,
      tags: ["compactor:structured-state"],
    },
  ];

  return {
    replacementMessages: replacement,
    stats: buildStats({
      original: transcript,
      replacement,
      preservedTail,
      systemPrefix,
      options,
      startedAt,
      extra: { recursed, regionSize: region.length, state },
    }),
  };
}

export const structuredStateCompactor: Compactor = {
  name: "structured-state",
  version: "1.0.0",
  compact: structuredCompact,
};

// ---------------------------------------------------------------------------
// Strategy: hierarchical-summary
// ---------------------------------------------------------------------------

const HIERARCHICAL_CHUNK_SIZE = 10;

const HIERARCHICAL_LEAF_SYSTEM_PROMPT =
  "You are a conversation summarizer. Summarize the given conversation chunk" +
  " in 3-6 sentences, preserving load-bearing facts, decisions, identifiers," +
  " and tool-call outcomes. Output prose only.";

const HIERARCHICAL_ROLLUP_SYSTEM_PROMPT =
  "You are a summary aggregator. Combine the given list of chunk summaries" +
  " into a single concise summary that preserves the most load-bearing facts" +
  " and decisions. Maintain chronological coherence. Output prose only.";

async function summarizeChunks(
  callModel: CompactorModelCall,
  chunks: CompactorMessage[][],
  options: CompactorOptions,
): Promise<string[]> {
  const summaries: string[] = [];
  for (const chunk of chunks) {
    const body = renderRegionForPrompt(chunk);
    const out = await callModel({
      systemPrompt: HIERARCHICAL_LEAF_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Summarize this conversation chunk:\n\n${body}`,
        },
      ],
      maxOutputTokens: Math.max(64, Math.floor(options.targetTokens / 2)),
    });
    summaries.push(out.trim());
  }
  return summaries;
}

async function hierarchicalCompact(
  transcript: CompactorTranscript,
  options: CompactorOptions,
): Promise<CompactionArtifact> {
  const startedAt = Date.now();
  const callModel = requireCallModel(options, "hierarchical-summary");
  const preserveTail = options.preserveTailMessages ?? DEFAULT_PRESERVE_TAIL;
  const { systemPrefix, region, preservedTail } = splitTranscript(
    transcript,
    preserveTail,
  );

  if (region.length === 0) {
    return {
      replacementMessages: [],
      stats: buildStats({
        original: transcript,
        replacement: [],
        preservedTail,
        systemPrefix,
        options,
        startedAt,
      }),
    };
  }

  // Split into chunks of HIERARCHICAL_CHUNK_SIZE.
  const chunks: CompactorMessage[][] = [];
  for (let i = 0; i < region.length; i += HIERARCHICAL_CHUNK_SIZE) {
    chunks.push(region.slice(i, i + HIERARCHICAL_CHUNK_SIZE));
  }

  let leafSummaries = await summarizeChunks(callModel, chunks, options);
  const counter = getCounter(options);

  // Roll up summaries until under budget OR no further progress.
  let levels = 0;
  let combined = leafSummaries.join("\n\n");
  while (counter(combined) > options.targetTokens && leafSummaries.length > 1) {
    levels += 1;
    // Group rollup-level summaries in chunks of HIERARCHICAL_CHUNK_SIZE summaries.
    const rollupChunks: string[][] = [];
    for (let i = 0; i < leafSummaries.length; i += HIERARCHICAL_CHUNK_SIZE) {
      rollupChunks.push(leafSummaries.slice(i, i + HIERARCHICAL_CHUNK_SIZE));
    }
    const next: string[] = [];
    for (const group of rollupChunks) {
      const body = group.map((s, i) => `Summary ${i + 1}:\n${s}`).join("\n\n");
      const out = await callModel({
        systemPrompt: HIERARCHICAL_ROLLUP_SYSTEM_PROMPT,
        messages: [
          { role: "user", content: `Combine these summaries:\n\n${body}` },
        ],
        maxOutputTokens: options.targetTokens,
      });
      next.push(out.trim());
    }
    if (next.length >= leafSummaries.length) break;
    leafSummaries = next;
    combined = leafSummaries.join("\n\n");
    if (levels > 8) break; // safety stop
  }

  // If we still have multiple summaries, do a final rollup into one.
  if (leafSummaries.length > 1) {
    const body = leafSummaries
      .map((s, i) => `Summary ${i + 1}:\n${s}`)
      .join("\n\n");
    const out = await callModel({
      systemPrompt: HIERARCHICAL_ROLLUP_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `Combine these summaries:\n\n${body}` },
      ],
      maxOutputTokens: options.targetTokens,
    });
    leafSummaries = [out.trim()];
    combined = leafSummaries[0];
    levels += 1;
  }

  const replacement: CompactorMessage[] = [
    {
      role: "assistant",
      content: `[conversation summary]\n${combined}`,
      tags: ["compactor:hierarchical-summary"],
    },
  ];

  return {
    replacementMessages: replacement,
    stats: buildStats({
      original: transcript,
      replacement,
      preservedTail,
      systemPrefix,
      options,
      startedAt,
      extra: {
        chunkCount: chunks.length,
        rollupLevels: levels,
        regionSize: region.length,
      },
    }),
  };
}

export const hierarchicalSummaryCompactor: Compactor = {
  name: "hierarchical-summary",
  version: "1.0.0",
  compact: hierarchicalCompact,
};

// ---------------------------------------------------------------------------
// Strategy: hybrid-ledger
// ---------------------------------------------------------------------------

type LedgerEntry = {
  /** Approximate position in the original conversation (message index). */
  index: number;
  /** Free-form note describing the event. */
  note: string;
};

const LEDGER_SYSTEM_PROMPT =
  "You are a conversation ledger extractor. Read the supplied transcript and" +
  " output a JSON object with exactly these keys:\n" +
  '  - "state": { "facts": string[], "decisions": string[],' +
  ' "pending_actions": string[], "entities": { [k: string]: string } }\n' +
  '  - "ledger": Array<{ "index": number, "note": string }>\n' +
  "The ledger is a chronological list of LOAD-BEARING events only — not" +
  " every turn. Skip greetings, filler, and acknowledgements. Each note must" +
  " be a single short clause (≤ 15 words). Cap the ledger at 10 entries; if" +
  " more events are load-bearing, merge nearby ones. The state is the" +
  " structured summary at the end of the conversation. Output ONLY the" +
  " JSON object, no prose, no markdown fences.";

const HYBRID_LEDGER_MAX_ENTRIES = 10;

type HybridParsed = {
  state: StructuredState;
  ledger: LedgerEntry[];
};

function safeParseHybrid(raw: string): HybridParsed {
  const trimmed = raw.trim();
  let body = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) body = fenceMatch[1].trim();
  else {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      body = trimmed.slice(firstBrace, lastBrace + 1);
    }
  }
  const parsed = JSON.parse(body) as {
    state?: Partial<StructuredState>;
    ledger?: Array<{ index?: number; note?: string }>;
  };
  const state: StructuredState = {
    facts: Array.isArray(parsed.state?.facts)
      ? parsed.state.facts.map(String)
      : [],
    decisions: Array.isArray(parsed.state?.decisions)
      ? parsed.state.decisions.map(String)
      : [],
    pending_actions: Array.isArray(parsed.state?.pending_actions)
      ? parsed.state.pending_actions.map(String)
      : [],
    entities:
      parsed.state?.entities && typeof parsed.state.entities === "object"
        ? Object.fromEntries(
            Object.entries(
              parsed.state.entities as Record<string, unknown>,
            ).map(([k, v]) => [k, String(v)]),
          )
        : {},
  };
  const ledger: LedgerEntry[] = Array.isArray(parsed.ledger)
    ? parsed.ledger
        .map((e) => ({
          index: typeof e.index === "number" ? e.index : 0,
          note: typeof e.note === "string" ? e.note : "",
        }))
        .filter((e) => e.note.length > 0)
        // Hard cap defends compression_ratio when the model ignores the
        // "≤ 10 entries" instruction in the prompt. Without the cap, the
        // ledger overhead can make the artifact larger than the input.
        .slice(0, HYBRID_LEDGER_MAX_ENTRIES)
    : [];
  return { state, ledger };
}

function renderHybrid(parsed: HybridParsed): string {
  const lines: string[] = ["[conversation hybrid-ledger]"];
  lines.push(renderStructuredState(parsed.state));
  lines.push("");
  lines.push("Ledger (chronological):");
  for (const e of parsed.ledger) {
    lines.push(`- @${e.index}: ${e.note}`);
  }
  return lines.join("\n");
}

async function hybridCompact(
  transcript: CompactorTranscript,
  options: CompactorOptions,
): Promise<CompactionArtifact> {
  const startedAt = Date.now();
  const callModel = requireCallModel(options, "hybrid-ledger");
  const preserveTail = options.preserveTailMessages ?? DEFAULT_PRESERVE_TAIL;
  const { systemPrefix, region, preservedTail } = splitTranscript(
    transcript,
    preserveTail,
  );

  if (region.length === 0) {
    return {
      replacementMessages: [],
      stats: buildStats({
        original: transcript,
        replacement: [],
        preservedTail,
        systemPrefix,
        options,
        startedAt,
      }),
    };
  }

  // If the transcript metadata carries a prior ledger from an earlier
  // compaction cycle, prepend it to the prompt so the model can extend
  // rather than discard it. This is what gives hybrid-ledger its multi-cycle
  // entity coherence.
  const priorLedger = (transcript.metadata?.priorLedger as string) ?? "";
  const userBody = priorLedger
    ? `Existing ledger (do not lose these entries — extend them):\n${priorLedger}\n\nNew conversation to fold in:\n${renderRegionForPrompt(region)}`
    : `Conversation:\n${renderRegionForPrompt(region)}`;

  const raw = await callModel({
    systemPrompt: LEDGER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userBody }],
    maxOutputTokens: options.targetTokens,
  });

  let parsed: HybridParsed;
  try {
    parsed = safeParseHybrid(raw);
  } catch {
    parsed = {
      state: { facts: [], decisions: [], pending_actions: [], entities: {} },
      ledger: [],
    };
  }

  let rendered = renderHybrid(parsed);
  const counter = getCounter(options);

  // Recursive condensation if over budget — ask the model to compress its
  // own output while preserving the ledger.
  let recursed = false;
  while (counter(rendered) > options.targetTokens) {
    recursed = true;
    const reduced = await callModel({
      systemPrompt: LEDGER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `Reduce this hybrid ledger to fit within ${options.targetTokens}` +
            ` tokens while preserving the most load-bearing facts and` +
            ` ledger entries:\n\n${rendered}`,
        },
      ],
      maxOutputTokens: options.targetTokens,
    });
    let reducedParsed: HybridParsed;
    try {
      reducedParsed = safeParseHybrid(reduced);
    } catch {
      break;
    }
    const next = renderHybrid(reducedParsed);
    if (counter(next) >= counter(rendered)) break;
    parsed = reducedParsed;
    rendered = next;
  }

  const replacement: CompactorMessage[] = [
    {
      role: "system",
      content: rendered,
      tags: ["compactor:hybrid-ledger"],
    },
  ];

  return {
    replacementMessages: replacement,
    stats: buildStats({
      original: transcript,
      replacement,
      preservedTail,
      systemPrefix,
      options,
      startedAt,
      extra: {
        recursed,
        regionSize: region.length,
        ledgerEntries: parsed.ledger.length,
        state: parsed.state,
        ledger: parsed.ledger,
        renderedLedger: rendered,
      },
    }),
  };
}

export const hybridLedgerCompactor: Compactor = {
  name: "hybrid-ledger",
  version: "1.0.0",
  compact: hybridCompact,
};

// ---------------------------------------------------------------------------
// Strategy registry
// ---------------------------------------------------------------------------

export const compactors: Record<string, Compactor> = {
  "naive-summary": naiveSummaryCompactor,
  "structured-state": structuredStateCompactor,
  "hierarchical-summary": hierarchicalSummaryCompactor,
  "hybrid-ledger": hybridLedgerCompactor,
};
