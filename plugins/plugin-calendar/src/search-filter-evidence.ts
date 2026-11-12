/** Source-bound read filters. No intent classifier, model call, or Calendar I/O. */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CalendarReadBinding,
  CalendarReadFilterEvidence,
} from "@elizaos/contracts";

type Message = {
  id?: string;
  agentId?: string;
  roomId: string;
  entityId: string;
  createdAt?: number;
  content: { text?: string };
};
export type FilterEvidence = CalendarReadFilterEvidence;
type ReadBinding = {
  operation: string;
  filterEvidence?: readonly FilterEvidence[];
  intentId?: string;
  execution?: CalendarReadBinding["execution"];
  purpose?: CalendarReadBinding["purpose"];
};
const directCustody = new AsyncLocalStorage<object>();
const custody = new WeakMap<
  object,
  {
    id?: string;
    roomId: string;
    actorId: string;
    at?: number;
    text?: string;
    agentId: string;
    bindings: readonly ReadBinding[];
    signal: AbortSignal;
  }
>();

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Structural proposal validation only; this never grants source or search authority. */
export function hasCalendarSearchFilterShape(
  value: unknown,
): value is Pick<FilterEvidence, "query" | "quote" | "origin">[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    value.every(
      (raw) =>
        record(raw) &&
        Object.keys(raw).every((k) =>
          ["query", "quote", "origin"].includes(k),
        ) &&
        typeof raw.query === "string" &&
        typeof raw.quote === "string" &&
        raw.query.trim().length > 0 &&
        raw.query.length <= 160 &&
        raw.quote.trim().length > 0 &&
        raw.quote.length <= 2048 &&
        (raw.origin === "current" || raw.origin === "referent"),
    )
  );
}

/** Referents come ONLY from the already authorized recent-message provider. */
export function bindFilterEvidence(
  value: unknown,
  current: Message,
  agentId: string,
  recent: readonly Message[],
): FilterEvidence[] | null {
  const currentCreatedAt = current.createdAt;
  if (
    !current.id ||
    (current.agentId !== undefined && current.agentId !== agentId) ||
    typeof currentCreatedAt !== "number" ||
    !Number.isFinite(currentCreatedAt) ||
    !hasCalendarSearchFilterShape(value)
  )
    return null;
  const result: FilterEvidence[] = [];
  for (const raw of value) {
    const query = raw.query.trim();
    // Accept a literal quoted title within a longer verbatim quotation, not
    // arbitrary shortened descriptions, paraphrases or invented terms.
    const quotedTitle = [`"${query}"`, `“${query}”`, `'${query}'`].some(
      (title) => raw.quote.includes(title),
    );
    if (query !== raw.quote.trim() && !quotedTitle) return null;
    const candidates =
      raw.origin === "current"
        ? [current]
        : recent.filter(
            (m) =>
              m.id !== current.id &&
              (m.agentId === undefined || m.agentId === agentId) &&
              m.roomId === current.roomId &&
              (m.entityId === current.entityId || m.entityId === agentId) &&
              typeof m.createdAt === "number" &&
              Number.isFinite(m.createdAt) &&
              m.createdAt <= currentCreatedAt,
          );
    const source = candidates.find(
      (m) =>
        m.id &&
        typeof m.content?.text === "string" &&
        m.content.text.includes(raw.quote as string),
    );
    if (
      !source?.id ||
      typeof source.createdAt !== "number" ||
      !Number.isFinite(source.createdAt)
    )
      return null;
    // Publish the exact verified span to the existing read-coverage contract,
    // which requires query === quote.trim(). Source custody still comes from
    // the complete verbatim quotation checked above.
    result.push({
      query,
      quote: query === raw.quote.trim() ? raw.quote : query,
      origin: raw.origin,
      sourceMessageId: source.id,
      sourceActorId: source.entityId,
      sourceRoomId: source.roomId,
      sourceCreatedAt: source.createdAt,
    });
  }
  return result;
}

/** Host-only custody uses the existing per-turn streaming constraints carrier. */
export function rememberCalendarReadBindings(
  turn: object,
  current: Message,
  agentId: string,
  bindings: readonly ReadBinding[],
  signal: AbortSignal,
): void {
  custody.set(turn, {
    id: current.id,
    roomId: current.roomId,
    actorId: current.entityId,
    at: current.createdAt,
    text: current.content.text,
    agentId,
    bindings: structuredClone(bindings),
    signal,
  });
}

/** Read the same host custody; no model-supplied plan field can substitute for it. */
function currentReadBindings(
  turn: object | undefined,
  current: Message,
  agentId: string,
): readonly ReadBinding[] | undefined {
  const owned =
    (turn ? custody.get(turn) : undefined) ??
    custody.get(directCustody.getStore() ?? {});
  if (
    !owned ||
    (current.agentId !== undefined && current.agentId !== agentId) ||
    owned.signal.aborted ||
    owned.id !== current.id ||
    owned.roomId !== current.roomId ||
    owned.actorId !== current.entityId ||
    owned.at !== current.createdAt ||
    owned.agentId !== agentId ||
    owned.text !== current.content.text
  )
    return undefined;
  return owned.bindings;
}

/** Planning-only prerequisites from this exact live request, never read-completion evidence. */
export function calendarMutationPrerequisites(
  turn: object | undefined,
  current: Message,
  agentId: string,
): Pick<CalendarReadBinding, "intentId" | "operation" | "execution">[] {
  const result: Pick<
    CalendarReadBinding,
    "intentId" | "operation" | "execution"
  >[] = [];
  for (const binding of currentReadBindings(turn, current, agentId) ?? []) {
    if (
      binding.purpose !== "mutation_prerequisite" ||
      (binding.operation !== "feed" && binding.operation !== "search_events") ||
      typeof binding.intentId !== "string" ||
      !/^intent:[1-9][0-9]*$/.test(binding.intentId) ||
      (binding.execution !== "required" && binding.execution !== "conditional")
    )
      continue;
    result.push({
      intentId: binding.intentId,
      operation: binding.operation,
      execution: binding.execution,
    });
  }
  return result;
}

/** Rejection must happen before getCalendarFeed, not after an empty search. */
export function calendarSearchFiltersAreBound(
  turn: object | undefined,
  current: Message,
  agentId: string,
  queries: readonly string[],
  normalize: (s: string) => string | undefined,
): boolean {
  if (
    !queries.length ||
    queries.some((q) => typeof q !== "string" || !q.trim())
  )
    return false;
  const bindings = currentReadBindings(turn, current, agentId);
  if (!bindings) return false;
  const bound = bindings
    .filter((b) => b.operation === "search_events")
    .flatMap((b) => b.filterEvidence ?? [])
    .map((e) => normalize(e.query))
    .filter(Boolean);
  return bound.length > 0 && queries.every((q) => bound.includes(normalize(q)));
}

/** Host-only entry after owner authorization. Tool arguments cannot create this
 * AsyncLocalStorage capability. Each exact filter is validated against the host
 * request and authorized recent messages; it expires with this callback. */
export function withCalendarSearchAuthorization<T>(
  input: {
    current: Message;
    agentId: string;
    recent: readonly Message[];
    filterEvidence: unknown;
    signal: AbortSignal;
  },
  execute: () => T,
): T {
  input.signal.throwIfAborted();
  const filters = bindFilterEvidence(
    input.filterEvidence,
    input.current,
    input.agentId,
    input.recent,
  );
  if (!filters) throw new Error("Invalid host Calendar search source evidence");
  const carrier = {};
  rememberCalendarReadBindings(
    carrier,
    input.current,
    input.agentId,
    [{ operation: "search_events", filterEvidence: filters }],
    input.signal,
  );
  try {
    const result = directCustody.run(carrier, execute);
    if (result && typeof (result as { then?: unknown }).then === "function")
      return Promise.resolve(result).finally(() =>
        custody.delete(carrier),
      ) as T;
    custody.delete(carrier);
    return result;
  } catch (error) {
    custody.delete(carrier);
    throw error;
  }
}
