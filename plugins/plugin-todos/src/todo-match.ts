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
  return content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
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

function contentTokens(content: string): string[] {
  const tokens = normalizeTodoContent(content).split(" ").filter(Boolean);
  const meaningful = tokens.filter((token) => !FILLER_TOKENS.has(token));
  return (meaningful.length > 0 ? meaningful : tokens).map(stem);
}

function tokenKey(content: string): string {
  return [...new Set(contentTokens(content))].sort().join(" ");
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

function matchWithinPool<T extends Pick<Todo, "content">>(
  query: string,
  pool: readonly T[],
): T[] {
  const normalized = normalizeTodoContent(query);
  const exact = pool.filter(
    (todo) => normalizeTodoContent(todo.content) === normalized,
  );
  if (exact.length > 0) return exact;
  const key = tokenKey(query);
  const sameTokens = pool.filter((todo) => tokenKey(todo.content) === key);
  if (sameTokens.length > 0) return sameTokens;
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
 * Resolve visible content to candidate todos. Open todos are preferred, so a
 * finished duplicate never makes an active todo ambiguous; closed todos are
 * considered only when no open todo matches. Returns every tied candidate.
 */
export function matchTodosByContent<T extends Pick<Todo, "content" | "status">>(
  query: string,
  todos: readonly T[],
): T[] {
  const open = matchWithinPool(query, todos.filter(isOpenTodo));
  if (open.length > 0) return open;
  return matchWithinPool(
    query,
    todos.filter((todo) => !isOpenTodo(todo)),
  );
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
