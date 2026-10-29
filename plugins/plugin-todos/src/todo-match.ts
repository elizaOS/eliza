/**
 * Visible-content addressing for Todos. Lists and provider text show only
 * content, so mutations resolve a user-visible phrase (or a close paraphrase)
 * against the caller's own scope and must land on exactly one row. Ambiguity is
 * reported with stable per-row refs instead of positional numbers, so a
 * clarification stays valid when the list changes between turns.
 */
import type { Todo } from "./types.js";

const FILLER_TOKENS = new Set([
  "a",
  "an",
  "the",
  "my",
  "our",
  "your",
  "this",
  "that",
  "todo",
  "task",
  "item",
]);

/** Minimum paraphrase similarity for a non-exact match to be considered. */
const PARAPHRASE_THRESHOLD = 0.6;
/** Paraphrase candidates this close to the best score stay ambiguous. */
const PARAPHRASE_TIE_MARGIN = 0.15;

/** Case-, punctuation-, and whitespace-insensitive form of todo content. */
export function normalizeTodoContent(content: string): string {
  return (
    content
      .normalize("NFKC")
      .toLowerCase()
      // A numeric minus is data, not ignorable punctuation.
      .replace(/(?<![\p{L}\p{N}])[-\u2212](?=\d)/gu, "negative ")
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

function singularize(token: string): string {
  // "es" is the plural only after a sibilant or "o" (boxes, dishes, watches,
  // heroes). Stripping it from every longer word turned "notes" into "not"
  // and "files" into "fil", so a chat command resolved a different todo.
  if (token.length > 4 && /(?:[sxz]|ch|sh|o)es$/u.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function stem(token: string): string {
  // Reduce the plural before the verb suffix. Both sides of a match run this
  // function, so a word family must collapse to one token: stripping only the
  // plural left "meetings" as "meeting" while the singular "meeting" became
  // "meet", so the same visible todo addressed in either form did not count as
  // one row and a create added a silent duplicate instead of asking.
  const singular = singularize(token);
  let reduced = singular;
  if (singular.length > 5 && singular.endsWith("ing")) {
    reduced = singular.slice(0, -3);
  } else if (singular.length > 4 && singular.endsWith("ed")) {
    reduced = singular.slice(0, -2);
  }
  // The consonant + "y" family spells the plural with "ie" and drops the "y"
  // before "ed"/"ing" ("party/parties", "copy/copies", "try/tried"), so the
  // forms above land on three different tokens ("party", "partie", "tri")
  // and the family never collapses. Map every spelling to "i": a trailing
  // "ie" (the plural after the "s" strip, and the base form of "movie" and
  // "cookie", which collapse today and must keep the token their plurals
  // get) and a trailing consonant + "y". A vowel + "y" ("play", "key")
  // already collapses through the plain rules and stays untouched.
  if (reduced.length > 2 && reduced.endsWith("ie")) {
    return `${reduced.slice(0, -2)}i`;
  }
  if (reduced.length > 2 && /[^aeiou]y$/u.test(reduced)) {
    return `${reduced.slice(0, -1)}i`;
  }
  return reduced;
}

function contentTokens(content: string): string[] {
  const tokens = normalizeTodoContent(content).split(" ").filter(Boolean);
  const meaningful = tokens.filter((token) => !FILLER_TOKENS.has(token));
  return (meaningful.length > 0 ? meaningful : tokens).map(stem);
}

function tokenKey(content: string): string {
  const tokens = contentTokens(content);
  // Reordering quantities changes the task, even when its word set is unchanged.
  return JSON.stringify([
    [...new Set(tokens)].sort(),
    tokens.filter((token) => /\p{N}/u.test(token)),
  ]);
}

/** Dice similarity over stemmed content tokens. */
function paraphraseScore(query: string, content: string): number {
  const left = new Set(contentTokens(query));
  const right = new Set(contentTokens(content));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return (2 * shared) / (left.size + right.size);
}

/** True when two contents name the same todo for duplicate detection. */
export function sameTodoContent(left: string, right: string): boolean {
  const a = normalizeTodoContent(left);
  const b = normalizeTodoContent(right);
  return a === b || (a.length > 0 && tokenKey(left) === tokenKey(right));
}

export function isOpenTodo(todo: Pick<Todo, "status">): boolean {
  return todo.status === "pending" || todo.status === "in_progress";
}

/**
 * Match steps from the strongest to the weakest: the same normalized text,
 * then the same set of words, then a paraphrase (Dice score).
 */
function matchByStage<T extends Pick<Todo, "content">>(
  query: string,
  pool: readonly T[],
  stage: "exact" | "sameTokens" | "paraphrase",
): T[] {
  if (stage === "exact") {
    const normalized = normalizeTodoContent(query);
    return pool.filter(
      (todo) => normalizeTodoContent(todo.content) === normalized,
    );
  }
  if (stage === "sameTokens") {
    const key = tokenKey(query);
    return pool.filter((todo) => tokenKey(todo.content) === key);
  }
  const scored = pool
    .map((todo) => ({ todo, score: paraphraseScore(query, todo.content) }))
    .filter((entry) => entry.score >= PARAPHRASE_THRESHOLD)
    .sort((left, right) => right.score - left.score);
  const best = scored[0]?.score;
  if (best === undefined) return [];
  return scored
    .filter((entry) => best - entry.score < PARAPHRASE_TIE_MARGIN)
    .map((entry) => entry.todo);
}

/**
 * Resolve visible content to candidate todos. A stronger match always wins
 * over a weaker one: an exact match on a finished todo beats a paraphrase of
 * an open one, so "complete Pay water bill" never changes "Pay electricity
 * bill". Within one step, open todos are preferred, so a finished duplicate
 * never makes an active todo ambiguous. Returns every tied candidate.
 */
export function matchTodosByContent<T extends Pick<Todo, "content" | "status">>(
  query: string,
  todos: readonly T[],
): T[] {
  const open = todos.filter(isOpenTodo);
  const closed = todos.filter((todo) => !isOpenTodo(todo));
  for (const stage of ["exact", "sameTokens", "paraphrase"] as const) {
    const openMatches = matchByStage(query, open, stage);
    if (openMatches.length > 0) return openMatches;
    const closedMatches = matchByStage(query, closed, stage);
    if (closedMatches.length > 0) return closedMatches;
  }
  return [];
}

/**
 * Stable, non-storage handle for one todo, used only to disambiguate between
 * rows that share visible content. Derived from the row id, so it survives
 * reordering, renames of other rows, and deletions.
 */
export async function todoRef(id: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`todo-ref:v1:${id}`),
  );
  return `t-${[...new Uint8Array(bytes).slice(0, 4)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Accept only the exact ref shape emitted by {@link todoRef}. */
export function readTodoRef(value: string): string | null {
  const ref = value.trim().toLowerCase();
  return /^t-[0-9a-f]{8}$/.test(ref) ? ref : null;
}
