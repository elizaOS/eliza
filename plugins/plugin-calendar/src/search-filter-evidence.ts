/** Source-bound read filters. No intent classifier, model call, or Calendar I/O. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { CalendarReadFilterEvidence } from "@elizaos/contracts";
type Message = {
  id?: string; agentId?: string; roomId: string; entityId: string;
  createdAt?: number; content: { text?: string };
};
export type FilterEvidence = CalendarReadFilterEvidence;
type ReadBinding = { operation: string; filterEvidence?: readonly FilterEvidence[] };
const directCustody = new AsyncLocalStorage<object>();
const custody = new WeakMap<object, { id?: string; roomId: string; actorId: string; at?: number; text?: string; agentId: string; bindings: ReadBinding[]; signal: AbortSignal }>();

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Referents come ONLY from the already authorized recent-message provider. */
export function bindFilterEvidence(
  value: unknown, current: Message, agentId: string, recent: readonly Message[],
): FilterEvidence[] | null {
  if (!current.id || (current.agentId !== undefined && current.agentId !== agentId) || !Number.isFinite(current.createdAt) ||
      !Array.isArray(value) || !value.length || value.length > 8) return null;
  const result: FilterEvidence[] = [];
  for (const raw of value) {
    if (!record(raw) || Object.keys(raw).some(k => !["query", "quote", "origin"].includes(k)) ||
        typeof raw.query !== "string" || typeof raw.quote !== "string" ||
        !raw.query.trim() || raw.query.length > 160 || raw.quote.length > 2048 ||
        raw.query.trim() !== raw.quote.trim() ||
        (raw.origin !== "current" && raw.origin !== "referent")) return null;
    const candidates = raw.origin === "current" ? [current] : recent.filter(m =>
      m.id !== current.id && (m.agentId === undefined || m.agentId === agentId) && m.roomId === current.roomId &&
      (m.entityId === current.entityId || m.entityId === agentId) &&
      Number.isFinite(m.createdAt) && m.createdAt! <= current.createdAt!);
    const source = candidates.find(m => m.id && typeof m.content?.text === "string" &&
      m.content.text.includes(raw.quote as string));
    if (!source?.id || !Number.isFinite(source.createdAt)) return null;
    result.push({ query: raw.query.trim(), quote: raw.quote, origin: raw.origin,
      sourceMessageId: source.id, sourceActorId: source.entityId,
      sourceRoomId: source.roomId, sourceCreatedAt: source.createdAt! });
  }
  return result;
}

/** Host-only custody uses the existing per-turn streaming constraints carrier. */
export function rememberCalendarReadBindings(
  turn: object, current: Message, agentId: string, bindings: readonly ReadBinding[], signal: AbortSignal,
): void {
  custody.set(turn, { id: current.id, roomId: current.roomId, actorId: current.entityId,
    at: current.createdAt, text: current.content.text, agentId,
    bindings: structuredClone(bindings), signal });
}

/** Rejection must happen before getCalendarFeed, not after an empty search. */
export function calendarSearchFiltersAreBound(
  turn: object | undefined, current: Message, agentId: string,
  queries: readonly string[], normalize: (s: string) => string | undefined,
): boolean {
  const owned = ((turn ? custody.get(turn) : undefined) ?? custody.get(directCustody.getStore() ?? {})) as {
    id: string; roomId: string; actorId: string; at: number; text: string;
    agentId: string; bindings: ReadBinding[]; signal: AbortSignal;
  } | undefined;
  if (!queries.length || queries.some(q => typeof q !== "string" || !q.trim())) return false;
  if (!owned || (current.agentId !== undefined && current.agentId !== agentId) || owned.signal.aborted || owned.id !== current.id || owned.roomId !== current.roomId ||
      owned.actorId !== current.entityId || owned.at !== current.createdAt ||
      owned.agentId !== agentId || owned.text !== current.content.text) return false;
  const bound = owned.bindings.filter(b => b.operation === "search_events")
    .flatMap(b => b.filterEvidence ?? []).map(e => normalize(e.query)).filter(Boolean);
  return bound.length > 0 && queries.every(q => bound.includes(normalize(q)));
}

/** Host-only entry after owner authorization. Tool arguments cannot create this
 * AsyncLocalStorage capability. Each exact filter is validated against the host
 * request and authorized recent messages; it expires with this callback. */
export function withCalendarSearchAuthorization<T>(input: {
  current: Message; agentId: string; recent: readonly Message[];
  filterEvidence: unknown; signal: AbortSignal;
}, execute: () => T): T {
  input.signal.throwIfAborted();
  const filters = bindFilterEvidence(input.filterEvidence, input.current, input.agentId, input.recent);
  if (!filters) throw new Error("Invalid host Calendar search source evidence");
  const carrier = {};
  rememberCalendarReadBindings(carrier, input.current, input.agentId,
    [{ operation: "search_events", filterEvidence: filters }], input.signal);
  try {
    const result = directCustody.run(carrier, execute);
    if (result && typeof (result as { then?: unknown }).then === "function")
      return Promise.resolve(result).finally(() => custody.delete(carrier)) as T;
    custody.delete(carrier);
    return result;
  } catch (error) {
    custody.delete(carrier);
    throw error;
  }
}
