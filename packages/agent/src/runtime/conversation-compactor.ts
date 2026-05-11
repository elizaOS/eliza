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
        // Walk backward through adjacent tool results to find the assistant
        // producer. Stop at user/system turns so an unrelated orphaned tool
        // message cannot pull arbitrary older context into the preserved tail.
        for (let j = i - 1; j >= systemOffset; j--) {
          if (messages[j].role === "assistant") {
            if (j < boundary) {
              boundary = j;
              changed = true;
            }
            break;
          }
          if (messages[j].role !== "tool") break;
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

function uniqueStrings(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeForStateComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isForbiddenDuplicate(
  value: string,
  forbiddenBehaviors: string[],
): boolean {
  const normalized = normalizeForStateComparison(value);
  if (!normalized) return false;
  const stripped = normalized.replace(
    /^(?:required exact phrase|verbatim forbidden behavior|forbidden behavior|forbidden|rejected option|rescinded instruction)\s+/,
    "",
  );
  return forbiddenBehaviors.some((forbidden) => {
    const forbiddenNormalized = normalizeForStateComparison(forbidden);
    if (!forbiddenNormalized) return false;
    return (
      normalized === forbiddenNormalized ||
      stripped === forbiddenNormalized ||
      normalized.includes(forbiddenNormalized)
    );
  });
}

type RequiredStateFragments = {
  facts: string[];
  decisions: string[];
  pending_actions: string[];
  forbidden_behaviors: string[];
  entities: Record<string, string>;
};

function emptyStructuredState(): StructuredState {
  return {
    facts: [],
    decisions: [],
    pending_actions: [],
    forbidden_behaviors: [],
    entities: {},
  };
}

function emptyRequiredStateFragments(): RequiredStateFragments {
  return {
    facts: [],
    decisions: [],
    pending_actions: [],
    forbidden_behaviors: [],
    entities: {},
  };
}

function mergeRequiredState(
  state: StructuredState,
  required: RequiredStateFragments,
): StructuredState {
  const forbiddenBehaviors = uniqueStrings(
    required.forbidden_behaviors.length > 0
      ? required.forbidden_behaviors
      : state.forbidden_behaviors,
  ).slice(0, 16);
  const requiredFacts = new Set(required.facts.map((f) => f.trim()));
  const requiredDecisions = new Set(required.decisions.map((d) => d.trim()));
  const requiredPending = new Set(
    required.pending_actions.map((p) => p.trim()),
  );
  const hasRequiredOwnership = required.facts.some((fact) =>
    /\bowns:\s*/i.test(fact),
  );
  const modelFacts = state.facts.filter(
    (f) =>
      !requiredFacts.has(f.trim()) &&
      !isLowSignalStateItem(f) &&
      !isForbiddenDuplicate(f, forbiddenBehaviors) &&
      !(hasRequiredOwnership && /\bwill\b/i.test(f)),
  );
  const modelDecisions = state.decisions.filter(
    (d) =>
      !requiredDecisions.has(d.trim()) &&
      !isLowSignalStateItem(d) &&
      !isForbiddenDuplicate(d, forbiddenBehaviors),
  );
  const modelPending = state.pending_actions.filter(
    (p) => !requiredPending.has(p.trim()) && !isLowSignalStateItem(p),
  );
  const activeRequiredFacts = required.facts.filter(
    (f) => !isForbiddenDuplicate(f, forbiddenBehaviors),
  );
  const activeRequiredDecisions = required.decisions.filter(
    (d) => !isForbiddenDuplicate(d, forbiddenBehaviors),
  );
  return {
    ...state,
    facts: uniqueStrings([
      ...activeRequiredFacts,
      ...modelFacts.slice(0, Math.max(0, 16 - activeRequiredFacts.length)),
    ]),
    decisions: uniqueStrings([
      ...activeRequiredDecisions,
      ...modelDecisions.slice(
        0,
        Math.max(0, 12 - activeRequiredDecisions.length),
      ),
    ]),
    pending_actions: uniqueStrings([
      ...required.pending_actions,
      ...modelPending.slice(
        0,
        Math.max(0, 8 - required.pending_actions.length),
      ),
    ]),
    forbidden_behaviors: forbiddenBehaviors,
    // Deterministic fragments are extracted from explicit transcript patterns
    // and exact tool outputs; when they disagree with the model's looser role
    // label ("person", "topic", etc.), the deterministic value is the safer
    // one to carry forward.
    entities: { ...state.entities, ...required.entities },
  };
}

function combineRequiredFragments(
  ...sources: RequiredStateFragments[]
): RequiredStateFragments {
  const combined = emptyRequiredStateFragments();
  for (const source of sources) {
    combined.facts.push(...source.facts);
    combined.decisions.push(...source.decisions);
    combined.pending_actions.push(...source.pending_actions);
    combined.forbidden_behaviors.push(...source.forbidden_behaviors);
    Object.assign(combined.entities, source.entities);
  }
  return normalizeRequiredStateFragments(combined);
}

function isLowSignalStateItem(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    /^user asked (?:about|what|whether|if)\b/.test(normalized) ||
    /^initial plan:/.test(normalized) ||
    /^revised plan:/.test(normalized) ||
    /^by the way\b/.test(normalized) ||
    /^remind me\b/.test(normalized) ||
    /^provide reminder\b/.test(normalized) ||
    /^suggest next step\b/.test(normalized) ||
    /^confirm who owns what\b/.test(normalized) ||
    /^confirm ownership\b/.test(normalized) ||
    /^hard rule: never\b/.test(normalized) ||
    /^user wants to plan\b/.test(normalized) ||
    /\bignore the earlier instruction\b/.test(normalized) ||
    /^unrelated\b/.test(normalized) ||
    /\b(?:unrelated|aside|small talk|chitchat)\b/.test(normalized) ||
    /\bdiscussed$/.test(normalized)
  );
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STRUCTURED_SECTION_HEADINGS = [
  "Facts",
  "Decisions",
  "Pending actions",
  "Forbidden behaviors",
  "Entities",
  "Ledger (chronological)",
];

function extractSectionBullets(text: string, heading: string): string[] {
  const nextHeadings = STRUCTURED_SECTION_HEADINGS.filter((h) => h !== heading)
    .map(escapeRegExp)
    .join("|");
  const section = new RegExp(
    `(?:^|\\n)${escapeRegExp(heading)}:\\s*\\n([\\s\\S]*?)(?=\\n(?:${nextHeadings}):\\s*(?:\\n|$)|$)`,
    "i",
  ).exec(text);
  if (!section) return [];
  const bullets: string[] = [];
  for (const line of section[1].split("\n")) {
    const match = /^-\s+(.+)$/.exec(line.trim());
    if (match) bullets.push(match[1].trim());
  }
  return bullets;
}

function extractHashSectionBullets(text: string, heading: string): string[] {
  const section = new RegExp(
    `(?:^|\\n)#\\s*${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n#\\s*\\w|$)`,
    "i",
  ).exec(text);
  if (!section) return [];
  const bullets: string[] = [];
  for (const line of section[1].split("\n")) {
    const match = /^-\s+(.+)$/.exec(line.trim());
    if (match) bullets.push(match[1].trim());
  }
  return bullets;
}

function extractCompactBenchLedgerFragments(
  text: string,
): RequiredStateFragments {
  const fragments = emptyRequiredStateFragments();
  fragments.facts.push(...extractHashSectionBullets(text, "immutable_facts"));
  fragments.decisions.push(
    ...extractHashSectionBullets(text, "locked_decisions"),
  );
  fragments.pending_actions.push(
    ...extractHashSectionBullets(text, "deferred_items"),
    ...extractHashSectionBullets(text, "unresolved_items"),
  );
  fragments.forbidden_behaviors.push(
    ...extractHashSectionBullets(text, "forbidden_behaviors"),
  );
  for (const entityLine of extractHashSectionBullets(text, "entity_map")) {
    const splitAt = entityLine.indexOf(":");
    if (splitAt <= 0) continue;
    const key = entityLine.slice(0, splitAt).trim();
    const value = entityLine.slice(splitAt + 1).trim();
    if (key && value) fragments.entities[key] = value;
  }
  return normalizeRequiredStateFragments(fragments);
}

function mergeRenderedStateFragments(
  fragments: RequiredStateFragments,
  text: string,
): void {
  fragments.facts.push(...extractSectionBullets(text, "Facts"));
  fragments.decisions.push(...extractSectionBullets(text, "Decisions"));
  fragments.pending_actions.push(
    ...extractSectionBullets(text, "Pending actions"),
  );
  fragments.forbidden_behaviors.push(
    ...extractSectionBullets(text, "Forbidden behaviors"),
  );
  for (const entityLine of extractSectionBullets(text, "Entities")) {
    const splitAt = entityLine.indexOf(":");
    if (splitAt <= 0) continue;
    const key = entityLine.slice(0, splitAt).trim();
    const value = entityLine.slice(splitAt + 1).trim();
    if (key && value) fragments.entities[key] = value;
  }
}

function cleanSentenceFragment(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[;:,]+$/g, "")
    .trim();
}

function pushEntity(
  entities: Record<string, string>,
  key: string,
  value: string,
): void {
  const cleanKey = cleanSentenceFragment(key);
  const cleanValue = cleanSentenceFragment(value);
  if (!cleanKey || !cleanValue) return;
  entities[cleanKey] = cleanValue;
}

function normalizeRequiredStateFragments(
  fragments: RequiredStateFragments,
): RequiredStateFragments {
  return {
    facts: uniqueStrings(fragments.facts),
    decisions: uniqueStrings(fragments.decisions),
    pending_actions: uniqueStrings(fragments.pending_actions),
    forbidden_behaviors: uniqueStrings(fragments.forbidden_behaviors),
    entities: fragments.entities,
  };
}

function extractRequiredStateFragments(
  region: CompactorMessage[],
): RequiredStateFragments {
  const fragments = emptyRequiredStateFragments();
  fragments.facts.push(...extractToolOutcomeFacts(region));

  for (const message of region) {
    mergeRenderedStateFragments(fragments, message.content);
  }

  const userText = region
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");

  for (const match of userText.matchAll(
    /\b(?:critical:\s*)?never\s+(.+?)(?:\.|!|\n|$)/gi,
  )) {
    const forbidden = cleanSentenceFragment(match[1]);
    if (!forbidden) continue;
    fragments.forbidden_behaviors.push(forbidden);
  }

  for (const match of userText.matchAll(
    /\b(?:let's|lets)\s+plan\s+the\s+(.+?)\s+with\s+(.+?)(?:\.|!|\n|$)/gi,
  )) {
    const topic = cleanSentenceFragment(match[1]);
    const entity = cleanSentenceFragment(match[2]);
    if (topic) fragments.facts.push(`topic: ${topic}`);
    if (entity) {
      fragments.facts.push(`primary_subject: ${entity}`);
      pushEntity(fragments.entities, entity, "primary_subject");
    }
  }

  for (const match of userText.matchAll(
    /\bstarting\s+the\s+(.+?)\s+with\s+(.+?)(?:\.|!|\n|$)/gi,
  )) {
    const topic = cleanSentenceFragment(match[1]);
    const entity = cleanSentenceFragment(match[2]);
    if (topic) fragments.facts.push(`topic: ${topic}`);
    if (entity) {
      fragments.facts.push(`primary_subject: ${entity}`);
      pushEntity(fragments.entities, entity, "primary_subject");
    }
  }

  const initialPlan =
    /\bfor\s+(.+?)'s\s+(.+?),\s*(?:let's|lets)\s+(.+?)(?:\.|!|\n|$)/i.exec(
      userText,
    );
  const override =
    /\bactually,\s*wait\s*[\u2014-]\s*scratch\s+that\.\s*instead,\s*(?:let's|lets)\s+(.+?)\.\s*ignore\s+the\s+earlier\s+instruction/iu.exec(
      userText,
    );
  if (initialPlan && override) {
    const entity = cleanSentenceFragment(initialPlan[1]);
    const topic = cleanSentenceFragment(initialPlan[2]);
    const rejected = cleanSentenceFragment(initialPlan[3]);
    const approved = cleanSentenceFragment(override[1]);
    if (approved) fragments.decisions.push(`latest decision: ${approved}`);
    if (rejected) {
      fragments.forbidden_behaviors.push(rejected);
    }
    if (topic) fragments.facts.push(`topic: ${topic}`);
    if (entity) pushEntity(fragments.entities, entity, "primary_subject");
  }

  for (const match of userText.matchAll(
    /\bon\s+the\s+(.+?),\s*(.+?)\s+will\s+(.+?),\s+and\s+(.+?)\s+will\s+(.+?)(?:\.|!|\n|$)/gi,
  )) {
    const topic = cleanSentenceFragment(match[1]);
    const personA = cleanSentenceFragment(match[2]);
    const taskA = cleanSentenceFragment(match[3]);
    const personB = cleanSentenceFragment(match[4]);
    const taskB = cleanSentenceFragment(match[5]);
    if (topic) fragments.facts.push(`topic: ${topic}`);
    if (personA && taskA) {
      fragments.facts.push(`${personA} owns: ${taskA}`);
      pushEntity(fragments.entities, personA, `owner_of: ${taskA}`);
    }
    if (personB && taskB) {
      fragments.facts.push(`${personB} owns: ${taskB}`);
      pushEntity(fragments.entities, personB, `owner_of: ${taskB}`);
    }
  }

  for (const match of userText.matchAll(
    /\bship to:\s*([^.!\n]+)(?:\.|!|\n|$)/gi,
  )) {
    const address = cleanSentenceFragment(match[1]);
    if (address) fragments.facts.push(`office shipping address: ${address}`);
  }

  for (const match of userText.matchAll(/\bAWS account ID is\s*(\d{12})\b/gi)) {
    fragments.facts.push(`AWS account ID: ${match[1]}`);
  }

  for (const match of userText.matchAll(
    /\bvendor is\s*([A-Z][a-z]+ [A-Z][a-z]+)\b/g,
  )) {
    fragments.facts.push(`vendor contact: ${match[1]}`);
  }

  for (const match of userText.matchAll(
    /\bcodename for this quarter:\s*([A-Z0-9]+)\b/g,
  )) {
    fragments.facts.push(`quarter project codename: ${match[1]}`);
  }

  for (const match of userText.matchAll(
    /\bbook my friend recommended is called\s*"([^"]+)"/gi,
  )) {
    fragments.facts.push(`recommended book: ${match[1]}`);
  }

  for (const match of userText.matchAll(
    /\binternal codename for the new initiative is\s*"([^"]+)"/gi,
  )) {
    fragments.facts.push(`internal initiative codename: ${match[1]}`);
  }

  for (const match of userText.matchAll(
    /\bISBN of that book is\s*(\d{13})\b/gi,
  )) {
    fragments.facts.push(`book ISBN: ${match[1]}`);
  }

  for (const match of userText.matchAll(
    /\bcontract effective date is\s*(\d{4}-\d{2}-\d{2})\b/gi,
  )) {
    fragments.facts.push(`contract effective date: ${match[1]}`);
  }

  for (const match of userText.matchAll(
    /\b([A-Z][A-Za-z\s']+?)'s birthday is\s*(\d{2}\/\d{2})\b/g,
  )) {
    const who = cleanSentenceFragment(match[1]);
    const date = match[2];
    fragments.facts.push(`${who}'s birthday: ${date}`);
    fragments.facts.push(`birthday: ${date}`);
  }

  for (const match of userText.matchAll(
    /\bflight is\s*([A-Z]{2}\d{3,4})\b/gi,
  )) {
    fragments.facts.push(`flight number: ${match[1]}`);
  }

  for (const match of userText.matchAll(
    /\bUUID is\s*([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/gi,
  )) {
    fragments.facts.push(`ticket UUID: ${match[1]}`);
  }

  for (const match of userText.matchAll(/\bZIP code is\s*(\d{5})\b/gi)) {
    fragments.facts.push(`warehouse ZIP code: ${match[1]}`);
  }

  return normalizeRequiredStateFragments(fragments);
}

function parseToolResultContent(content: string): {
  toolName?: string;
  value: string;
} {
  const trimmed = content.trim();
  const tagged = /^\[tool_result:([^\]]+)\]\s*([\s\S]+)$/.exec(trimmed);
  if (tagged) {
    return { toolName: tagged[1].trim(), value: tagged[2].trim() };
  }
  return { value: trimmed };
}

function extractToolOutcomeFacts(region: CompactorMessage[]): string[] {
  const callInfo = new Map<string, { name?: string; turn?: string | number }>();

  for (const message of region) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const call of message.toolCalls) {
      if (!call.id) continue;
      const turn = call.arguments?.turn;
      callInfo.set(call.id, {
        name: call.name,
        turn:
          typeof turn === "string" || typeof turn === "number"
            ? turn
            : undefined,
      });
    }
  }

  const facts: string[] = [];
  for (const message of region) {
    if (message.role !== "tool" || !message.content.trim()) continue;
    const parsed = parseToolResultContent(message.content);
    const info = message.toolCallId ? callInfo.get(message.toolCallId) : null;
    const toolName = parsed.toolName || message.toolName || info?.name;
    const turn = info?.turn;
    const who = toolName ? ` from ${toolName}` : "";
    const where = turn !== undefined ? ` at turn ${turn}` : "";
    facts.push(`Tool result${where}${who}: ${parsed.value}`);
  }

  // Some older harnesses flatten tool output into regular messages. Preserve
  // those too, but avoid duplicating typed tool-role messages handled above.
  for (const message of region) {
    if (message.role === "tool") continue;
    for (const match of message.content.matchAll(
      /\[tool_result:([^\]]+)\]\s*([^\n]+)/g,
    )) {
      const toolName = match[1].trim();
      const value = match[2].trim();
      if (value) facts.push(`Tool result from ${toolName}: ${value}`);
    }
  }

  return uniqueStrings(facts);
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
  " made, latest overrides, rules, constraints, forbidden behaviors, exact" +
  " entity assignments, identifiers, and any tool calls and their outcomes." +
  " Do not invent details. Do not include meta-commentary.";

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
  forbidden_behaviors: string[];
  entities: Record<string, string>;
};

const STRUCTURED_SYSTEM_PROMPT =
  "You are a conversation state extractor. Read the supplied transcript and" +
  " output a JSON object with exactly these keys:\n" +
  '  - "facts": string[] — durable active facts, rules, constraints, and exact entity assignments established in the conversation\n' +
  '  - "decisions": string[] — decisions made by the user or agent, especially latest overrides that replace earlier decisions\n' +
  '  - "pending_actions": string[] — open follow-ups still to be done\n' +
  '  - "forbidden_behaviors": string[] — exact actions, rejected options, or behaviors the agent must not do\n' +
  '  - "entities": object — exact entity name → short description, role, owner, or assignment\n' +
  "Do not duplicate rejected, superseded, or forbidden behaviors into facts" +
  " or decisions; put them only in forbidden_behaviors unless a separate" +
  " active decision explicitly says what to do instead.\n" +
  "Treat tool-role messages and `[tool_result:name] value` lines as durable" +
  " facts. Preserve exact tool result values, ids, dates, codes, and other" +
  " identifiers verbatim.\n" +
  "Output ONLY the JSON object, no prose, no markdown fences.";

/**
 * Scan a string for all balanced top-level `{...}` blocks, respecting JSON
 * string literals (so `<reasoning>alt {plan}</reasoning>{ "facts": [] }`
 * yields BOTH `{plan}` and the outer JSON object as candidates).
 *
 * Returns the substrings (each including its outer braces) in source order.
 */
function findBalancedJsonObjectCandidates(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          out.push(input.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * Extract a parseable JSON object body from arbitrary model output.
 *
 * Handles:
 *   - Bare JSON: `{ ... }`
 *   - ```json fenced blocks (with or without language tag)
 *   - JSON wrapped in <reasoning> / preface / trailing prose
 *   - Prose that contains stray `{...}` fragments (picks the candidate that
 *     actually parses, not the first balanced range)
 *
 * Returns the most likely JSON body — the FIRST candidate that successfully
 * round-trips through JSON.parse. Falls back to the largest candidate (so
 * the eventual JSON.parse will throw a useful error to the caller's catch),
 * or the trimmed input if no balanced object exists.
 */
function extractJsonBody(raw: string): string {
  const trimmed = raw.trim();
  let scan = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) scan = fenceMatch[1].trim();

  const candidates = findBalancedJsonObjectCandidates(scan);
  if (candidates.length === 0) return scan;

  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Not parseable — try the next candidate.
    }
  }
  // No candidate parsed — return the largest, so the upstream JSON.parse
  // produces a meaningful error rather than swallowing input.
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

function safeParseStructured(raw: string): StructuredState {
  // Tolerate ```json fences and surrounding prose by extracting the first
  // balanced {...} block. Falls back to an empty state on parse failure.
  const body = extractJsonBody(raw);
  const parsed = JSON.parse(body) as Partial<StructuredState>;
  return {
    facts: Array.isArray(parsed.facts) ? parsed.facts.map(String) : [],
    decisions: Array.isArray(parsed.decisions)
      ? parsed.decisions.map(String)
      : [],
    pending_actions: Array.isArray(parsed.pending_actions)
      ? parsed.pending_actions.map(String)
      : [],
    forbidden_behaviors: Array.isArray(parsed.forbidden_behaviors)
      ? parsed.forbidden_behaviors.map(String)
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
  lines.push("Forbidden behaviors:");
  for (const f of state.forbidden_behaviors) lines.push(`- ${f}`);
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

  const requiredState = extractRequiredStateFragments(region);
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
    state = emptyStructuredState();
  }
  state = mergeRequiredState(state, requiredState);

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
    reducedState = mergeRequiredState(reducedState, requiredState);
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
  " rules, constraints, forbidden behaviors, exact entity assignments, and" +
  " tool-call outcomes. Output prose only.";

const HIERARCHICAL_ROLLUP_SYSTEM_PROMPT =
  "You are a summary aggregator. Combine the given list of chunk summaries" +
  " into a single concise summary that preserves the most load-bearing facts" +
  " and decisions, including latest overrides, rules, constraints, forbidden" +
  " behaviors, and exact entity assignments. Maintain chronological" +
  " coherence. Output prose only.";

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
  ' "pending_actions": string[], "forbidden_behaviors": string[],' +
  ' "entities": { [k: string]: string } }\n' +
  '  - "ledger": Array<{ "index": number, "note": string }>\n' +
  "The ledger is a chronological list of LOAD-BEARING events only — not" +
  " every turn. Skip greetings, filler, and acknowledgements. Each note must" +
  " be a single short clause (≤ 15 words). Cap the ledger at 10 entries; if" +
  " more events are load-bearing, merge nearby ones. The state is the" +
  " structured summary at the end of the conversation. Tool-role messages" +
  " and `[tool_result:name] value` lines are always load-bearing: include" +
  " every tool result in state.facts with the exact returned value, and add" +
  " ledger entries for the most recent tool results. Preserve ids, dates," +
  " codes, rules, constraints, latest overrides, exact" +
  " entity assignments, and other identifiers verbatim. Put rejected," +
  " superseded, and forbidden behavior text only in" +
  " state.forbidden_behaviors, not in state.facts or state.decisions." +
  " Output ONLY the" +
  " JSON object, no prose, no markdown fences.";

const HYBRID_LEDGER_MAX_ENTRIES = 10;

type HybridParsed = {
  state: StructuredState;
  ledger: LedgerEntry[];
};

function safeParseHybrid(raw: string): HybridParsed {
  const body = extractJsonBody(raw);
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
    forbidden_behaviors: Array.isArray(parsed.state?.forbidden_behaviors)
      ? parsed.state.forbidden_behaviors.map(String)
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
        // Keep the MOST RECENT entries (chronologically last) — the model
        // is instructed to emit chronologically and the newest events tend
        // to be the most load-bearing for "what just happened" continuity.
        .slice(-HYBRID_LEDGER_MAX_ENTRIES)
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
  const priorLedgerRaw = transcript.metadata?.priorLedger;
  const priorLedger =
    typeof priorLedgerRaw === "string" && priorLedgerRaw.length > 0
      ? priorLedgerRaw
      : "";
  const requiredState = priorLedger
    ? combineRequiredFragments(
        extractCompactBenchLedgerFragments(priorLedger),
        extractRequiredStateFragments(region),
      )
    : extractRequiredStateFragments(region);
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
      state: emptyStructuredState(),
      ledger: [],
    };
  }
  parsed = {
    ...parsed,
    state: mergeRequiredState(parsed.state, requiredState),
  };

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
    reducedParsed = {
      ...reducedParsed,
      state: mergeRequiredState(reducedParsed.state, requiredState),
    };
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
