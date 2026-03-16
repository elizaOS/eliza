import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import doctorScript from "../../shared/doctor.json";
import type {
  ElizaDoctorJson,
  ElizaKeywordEntry,
  ElizaScriptRule,
  ElizaSessionState,
} from "../types";

const script = doctorScript as ElizaDoctorJson;
const substitutions = script.substitutions ?? {};

const sessionStateByRuntime = new WeakMap<IAgentRuntime, ElizaSessionState>();
const defaultStandaloneSession: ElizaSessionState = {
  limit: 1,
  memories: [],
  reassemblyIndex: new Map<string, number>(),
};

function getOrCreateSession(runtime: IAgentRuntime): ElizaSessionState {
  const existing = sessionStateByRuntime.get(runtime);
  if (existing) return existing;
  const created: ElizaSessionState = {
    limit: 1,
    memories: [],
    reassemblyIndex: new Map<string, number>(),
  };
  sessionStateByRuntime.set(runtime, created);
  return created;
}

type Token =
  | { kind: "wildcard" }
  | { kind: "literal"; value: string }
  | { kind: "alt"; options: readonly string[] }
  | { kind: "group"; groupName: string };

function normalizeRawInput(input: string): string {
  return input
    .trim()
    .replace(/[!?;:]+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ");
}

function tokenizeWords(text: string): string[] {
  const cleaned = normalizeRawInput(text)
    .replace(/[.,"()]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  const canonicalizationKeys = new Set(["dont", "cant", "wont", "dreamed", "dreams", "mom", "dad"]);
  return cleaned
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) =>
      canonicalizationKeys.has(w) ? (substitutions[w] ?? script.reflections[w] ?? w) : w
    );
}

function reflectWords(words: readonly string[]): string[] {
  return words.map((w) => script.reflections[w] ?? w);
}

function reflectText(text: string): string {
  return reflectWords(tokenizeWords(text)).join(" ");
}

function substituteWordsForMatching(words: readonly string[]): string[] {
  // Approximate classic keyword substitutions. `doctor.json` encodes the script's "=" substitutions
  // via `reflections` values (e.g. "my" -> "your", "you're" -> "I am").
  // We apply these substitutions for matching (not for keyword scanning), and normalize to lowercase.
  const out: string[] = [];
  for (const w of words) {
    const mapped = substitutions[w] ?? script.reflections[w];
    if (!mapped) {
      out.push(w.toLowerCase());
      continue;
    }

    const parts = mapped
      .toLowerCase()
      .split(/\s+/g)
      .filter((p) => p.length > 0);

    if (parts.length === 0) out.push(w.toLowerCase());
    else out.push(...parts);
  }
  return out;
}

function tokenizeForScan(input: string): string[] {
  // Keep ',' and '.' as clause delimiters, and treat 'but' as a delimiter word.
  const cleaned = normalizeRawInput(input)
    .replace(/[.,]/g, " | ")
    .replace(/["()]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  const canonicalizationKeys = new Set(["dont", "cant", "wont", "dreamed", "dreams", "mom", "dad"]);
  return cleaned
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) =>
      canonicalizationKeys.has(w) ? (substitutions[w] ?? script.reflections[w] ?? w) : w
    );
}

function splitIntoClauses(words: readonly string[]): string[][] {
  const clauses: string[][] = [];
  let current: string[] = [];

  for (const w of words) {
    if (w === "|" || w === "but") {
      if (current.length > 0) clauses.push(current);
      current = [];
      continue;
    }
    current.push(w);
  }
  if (current.length > 0) clauses.push(current);
  return clauses;
}

function buildKeywordIndex(keywords: readonly ElizaKeywordEntry[]): Map<string, ElizaKeywordEntry> {
  const map = new Map<string, ElizaKeywordEntry>();
  for (const entry of keywords) {
    for (const k of entry.keyword) {
      map.set(k.toLowerCase(), entry);
    }
  }
  return map;
}

const keywordIndex = buildKeywordIndex(script.keywords);

interface FoundKeyword {
  entry: ElizaKeywordEntry;
  keyword: string;
  position: number;
}

function findKeywordsInClause(words: readonly string[]): FoundKeyword[] {
  const found: FoundKeyword[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const entry = keywordIndex.get(w);
    if (!entry) continue;
    found.push({ entry, keyword: w, position: i });
  }
  return found;
}

function selectKeywordStack(words: readonly string[]): {
  stack: FoundKeyword[];
  clauseWords: string[];
} {
  // Recreate keyword-stack behavior: choose best clause (left-to-right) that contains any keyword,
  // then order by precedence desc, tie-break by earliest position.
  const clauses = splitIntoClauses(words);
  for (const clause of clauses) {
    const found = findKeywordsInClause(clause);
    if (found.length === 0) continue;
    const stack = [...found].sort((a, b) => {
      if (b.entry.precedence !== a.entry.precedence) return b.entry.precedence - a.entry.precedence;
      return a.position - b.position;
    });
    return { stack, clauseWords: clause };
  }
  return { stack: [], clauseWords: [] };
}

function parseDecomposition(pattern: string): Token[] {
  // Pattern language used by doctor.json:
  // - "*" wildcard (matches 0+ words)
  // - "[a b c]" one-of alternatives
  // - "@group" group reference (e.g. @belief)
  // - otherwise: literal word
  const raw = pattern.trim().replace(/\s+/g, " ").toLowerCase();
  if (!raw) return [];

  const tokens: Token[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && raw[i] === " ") i++;
    if (i >= raw.length) break;

    const ch = raw[i];
    if (ch === "*") {
      tokens.push({ kind: "wildcard" });
      i++;
      continue;
    }
    if (ch === "@") {
      let j = i + 1;
      while (j < raw.length && raw[j] !== " ") j++;
      const groupName = raw.slice(i + 1, j).trim();
      if (groupName.length > 0) tokens.push({ kind: "group", groupName });
      i = j;
      continue;
    }
    if (ch === "[") {
      const close = raw.indexOf("]", i + 1);
      if (close === -1) {
        // Malformed; treat the rest as literal.
        const rest = raw.slice(i).trim();
        if (rest.length > 0) tokens.push({ kind: "literal", value: rest });
        break;
      }
      const inside = raw.slice(i + 1, close).trim();
      const options = inside.length > 0 ? inside.split(/\s+/g) : [];
      tokens.push({ kind: "alt", options });
      i = close + 1;
      continue;
    }

    // literal word
    let j = i;
    while (j < raw.length && raw[j] !== " ") j++;
    const word = raw.slice(i, j).trim();
    if (word.length > 0) tokens.push({ kind: "literal", value: word });
    i = j;
  }
  return tokens;
}

function tokenMatchesWord(token: Token, word: string): boolean {
  if (token.kind === "literal") return token.value === word;
  if (token.kind === "alt") return token.options.includes(word);
  if (token.kind === "group") {
    const groupWords = script.groups[token.groupName];
    if (!groupWords) return false;
    return groupWords.includes(word);
  }
  return false;
}

interface MatchResult {
  /** Parts aligned to pattern tokens, 1-indexed in reassembly strings as $1, $2... */
  parts: string[];
}

function matchDecomposition(
  tokens: readonly Token[],
  words: readonly string[]
): MatchResult | null {
  // Backtracking match for wildcard "*" tokens.
  // We produce `parts` array where parts[i] is the matched text for tokens[i].
  const parts: string[] = new Array(tokens.length).fill("");

  function backtrack(ti: number, wi: number): boolean {
    if (ti === tokens.length) return wi === words.length;

    const token = tokens[ti];
    if (token.kind === "wildcard") {
      // Try minimal to maximal consumption.
      for (let end = wi; end <= words.length; end++) {
        parts[ti] = words.slice(wi, end).join(" ").trim();
        if (backtrack(ti + 1, end)) return true;
      }
      return false;
    }

    if (wi >= words.length) return false;
    const w = words[wi];
    if (!tokenMatchesWord(token, w)) return false;

    parts[ti] = w;
    return backtrack(ti + 1, wi + 1);
  }

  if (!backtrack(0, 0)) return null;
  return { parts };
}

function applyReassembly(template: string, parts: readonly string[]): string {
  // Replace $N with reflected part N (1-indexed).
  return template.replace(/\$(\d+)/g, (_m, nRaw: string) => {
    const n = Number.parseInt(nRaw, 10);
    if (!Number.isFinite(n) || n <= 0) return "";
    const part = parts[n - 1] ?? "";
    return reflectText(part);
  });
}

function stableKeyForRule(keyword: string, rule: ElizaScriptRule, ruleIndex: number): string {
  return `${keyword}::${ruleIndex}::${rule.decomposition}`;
}

function pickNextReassembly(
  session: ElizaSessionState,
  keyword: string,
  rule: ElizaScriptRule,
  ruleIndex: number
): string {
  const key = stableKeyForRule(keyword, rule, ruleIndex);
  const current = session.reassemblyIndex.get(key) ?? 0;
  const idx = current % rule.reassembly.length;
  session.reassemblyIndex.set(key, (current + 1) % Math.max(1, rule.reassembly.length));
  return rule.reassembly[idx] ?? "";
}

function computeWordHash(word: string): number {
  // Deterministic small hash (not SLIP HASH, but stable enough for memory rule selection).
  let h = 0;
  for (let i = 0; i < word.length; i++) {
    h = (h * 31 + word.charCodeAt(i)) >>> 0;
  }
  return h;
}

function chooseDefaultResponse(session: ElizaSessionState): string {
  if (session.limit === 4 && session.memories.length > 0) {
    const m = session.memories.shift();
    if (m) return m;
  }
  // Cycle through NONE/default like classic: doctor.json provides the NONE list as `default`.
  const idx = (session.reassemblyIndex.get("__default__") ?? 0) % script.default.length;
  session.reassemblyIndex.set("__default__", idx + 1);
  return script.default[idx] ?? script.default[0] ?? "Please go on.";
}

function isGoodbye(words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const first = words[0];
  return script.goodbyes.some((g) => tokenizeWords(g)[0] === first);
}

function resolveRedirectKeyword(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed.startsWith("=")) return null;
  const k = trimmed.slice(1).trim().toLowerCase();
  return k.length > 0 ? k : null;
}

function parsePreDirective(s: string): { preText: string; redirect: string } | null {
  // Format: ":pre <text> (=keyword)"
  const m = s.trim().match(/^:pre\s+(.+?)\s+\(=\s*([^)]+)\s*\)\s*$/i);
  if (!m) return null;
  const preText = m[1]?.trim() ?? "";
  const redirect = m[2]?.trim().toLowerCase() ?? "";
  if (!preText || !redirect) return null;
  return { preText, redirect };
}

function isNewKeyDirective(s: string): boolean {
  return s.trim().toLowerCase() === ":newkey" || s.trim().toLowerCase() === "newkey";
}

type RuleEvalResult =
  | { kind: "no_match" }
  | { kind: "newkey" }
  | { kind: "redirect"; keyword: string }
  | { kind: "pre"; preText: string; redirect: string; parts: readonly string[] }
  | { kind: "response"; text: string };

function tryRulesForKeyword(
  session: ElizaSessionState,
  keyword: string,
  entry: ElizaKeywordEntry,
  words: readonly string[]
): RuleEvalResult {
  for (let i = 0; i < entry.rules.length; i++) {
    const rule = entry.rules[i];
    const tokens = parseDecomposition(rule.decomposition);
    const match = matchDecomposition(tokens, words);
    if (!match) continue;

    const picked = pickNextReassembly(session, keyword, rule, i);
    if (isNewKeyDirective(picked)) return { kind: "newkey" };

    const pre = parsePreDirective(picked);
    if (pre)
      return { kind: "pre", preText: pre.preText, redirect: pre.redirect, parts: match.parts };

    const redirect = resolveRedirectKeyword(picked);
    if (redirect) return { kind: "redirect", keyword: redirect };

    return {
      kind: "response",
      text: applyReassembly(picked, match.parts).replace(/\s+/g, " ").trim(),
    };
  }
  return { kind: "no_match" };
}

function maybeRecordMemory(
  session: ElizaSessionState,
  entry: ElizaKeywordEntry,
  words: readonly string[]
): void {
  const memoryRules = entry.memory;
  if (!memoryRules || memoryRules.length === 0) return;
  const last = words.length > 0 ? words[words.length - 1] : "";
  const chosenIdx = computeWordHash(last) % memoryRules.length;
  const chosen = memoryRules[chosenIdx];
  if (!chosen) return;

  const tokens = parseDecomposition(chosen.decomposition);
  const match = matchDecomposition(tokens, words);
  if (!match) return;

  // In the original script, MEMORY has 4 patterns; in doctor.json it's represented as one rule with 4 reassemblies.
  const responseIdx = computeWordHash(last) % Math.max(1, chosen.reassembly.length);
  const template = chosen.reassembly[responseIdx] ?? chosen.reassembly[0] ?? "";
  const response = applyReassembly(template, match.parts).replace(/\s+/g, " ").trim();
  if (response.length > 0) session.memories.push(response);
}

export function reflect(text: string): string {
  return reflectText(text);
}

export function generateElizaResponse(input: string): string;
export function generateElizaResponse(runtime: IAgentRuntime, input: string): string;
export function generateElizaResponse(arg1: IAgentRuntime | string, arg2?: string): string {
  const runtime = typeof arg1 === "string" ? null : arg1;
  const input = typeof arg1 === "string" ? arg1 : (arg2 ?? "");

  const session = runtime ? getOrCreateSession(runtime) : defaultStandaloneSession;

  // LIMIT increments each user input (1..4 cycle).
  session.limit = session.limit === 4 ? 1 : ((session.limit + 1) as 2 | 3 | 4);

  const scanWords = tokenizeForScan(input);
  const words = tokenizeWords(input);
  if (words.length === 0) return chooseDefaultResponse(session);

  if (isGoodbye(words)) {
    return script.goodbyes[0] ?? "Goodbye.";
  }

  const { stack: keywordStack, clauseWords } = selectKeywordStack(scanWords);
  if (keywordStack.length === 0 || clauseWords.length === 0) {
    return chooseDefaultResponse(session);
  }

  const matchWords = substituteWordsForMatching(clauseWords);

  // Try keywords in order; NEWKEY forces trying the next one.
  for (const found of keywordStack) {
    maybeRecordMemory(session, found.entry, matchWords);
    const result = tryRulesForKeyword(session, found.keyword, found.entry, matchWords);
    if (result.kind === "no_match") continue;
    if (result.kind === "newkey") continue;

    if (result.kind === "pre") {
      const preApplied = applyReassembly(result.preText, result.parts).replace(/\s+/g, " ").trim();
      // PRE constructs a new input phrase that should be fed directly into the target keyword's
      // decomposition rules (without additional global substitutions).
      const preWords = tokenizeWords(preApplied);
      const redirectedEntry = keywordIndex.get(result.redirect);
      if (!redirectedEntry) continue;
      const redirected = tryRulesForKeyword(session, result.redirect, redirectedEntry, preWords);
      if (redirected.kind === "response") return redirected.text;
      continue;
    }

    if (result.kind === "redirect") {
      const redirectedEntry = keywordIndex.get(result.keyword);
      if (!redirectedEntry) continue;
      const redirected = tryRulesForKeyword(session, result.keyword, redirectedEntry, matchWords);
      if (redirected.kind === "response") return redirected.text;
      continue;
    }

    if (result.kind === "response") return result.text;
  }

  return chooseDefaultResponse(session);
}

export function getElizaGreeting(): string {
  return (
    script.greetings[1] ?? script.greetings[0] ?? "How do you do. Please tell me your problem."
  );
}

function extractUserMessage(prompt: string): string {
  const match = prompt.match(/(?:User|Human|You):\s*(.+?)(?:\n|$)/i);
  return match ? match[1].trim() : prompt.trim();
}

export async function handleTextLarge(
  _runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const input = extractUserMessage(params.prompt);
  return generateElizaResponse(_runtime, input);
}

export async function handleTextSmall(
  runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  return handleTextLarge(runtime, params);
}
