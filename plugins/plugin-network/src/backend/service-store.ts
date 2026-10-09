/**
 * NetworkStore backed by the Network service, for one open turn. The member context comes from the
 * turn's `open` response (no second call); writes go to the service's signed /internal/* endpoints.
 * The plugin's `memberId` is the Cloud user id; the service's own member id and app come from the
 * turn, never from model output.
 */
import type { NetworkAppId, TurnContext } from "./contract.js";
import type { NetworkServiceClient } from "./client.js";
import type { NetworkMemberContext, NetworkStore, SetStateExecution } from "../types.js";

export interface ServiceTurn { app: NetworkAppId; memberId: string; messageId: string; context: TurnContext }

export function createServiceNetworkStore(client: NetworkServiceClient, turn: ServiceTurn): NetworkStore {
  const ctx = turn.context;
  return {
    async getMemberContext(): Promise<NetworkMemberContext | null> {
      return {
        memberId: turn.memberId,
        firstName: ctx.firstName ?? "",
        city: ctx.city ?? "",
        state: ctx.state,
        stateFrom: ctx.stateFrom,
        stateUntil: ctx.stateUntil,
        facets: ctx.facets,
        activeItems: ctx.activeItems.map(({ kind, summary }) => ({ kind, summary })),
      };
    },
    async readUpdates() {
      return client.readUpdates({ app: turn.app, memberId: turn.memberId, messageId: turn.messageId });
    },
    async setState(input): Promise<SetStateExecution> {
      const r = await client.setState({
        idempotencyKey: input.idempotencyKey, app: turn.app, memberId: turn.memberId,
        state: input.state, from: input.from ?? null, until: input.until, note: input.note,
      });
      return { ...r, committedAt: new Date(r.committedAt) };
    },
    async recordSignals(input) {
      return client.recordSignals({ messageId: input.messageId, app: turn.app, memberId: turn.memberId, signals: input.signals });
    },
  };
}

const APPS = new Set(["ntwrk", "slop", "peon", "friends"]);
const STATES = new Set(["open", "busy", "traveling", "paused"]);
const str = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const strOrNull = (v: unknown) => v === null || (typeof v === "string" && v.length <= 200);

/** Strict shape check for a ServiceTurn crossing a process boundary (gateway → Cloud → runtime). */
export function parseServiceTurn(v: unknown): ServiceTurn | undefined {
  if (!v || typeof v !== "object") return undefined;
  const t = v as Record<string, unknown>;
  const c = t.context as Record<string, unknown> | undefined;
  if (!str(t.app, 16) || !APPS.has(t.app) || !str(t.memberId) || !str(t.messageId) || !c || typeof c !== "object") return undefined;
  if (!strOrNull(c.firstName) || !strOrNull(c.city) || !str(c.state, 16) || !STATES.has(c.state)) return undefined;
  if (!strOrNull(c.stateFrom) || !strOrNull(c.stateUntil) || typeof c.singlePlayer !== "boolean") return undefined;
  if (!Array.isArray(c.facets) || c.facets.length > 50 || !c.facets.every((f) => str(f, 300))) return undefined;
  if (!Array.isArray(c.activeItems) || c.activeItems.length > 20) return undefined;
  const items = c.activeItems as Array<Record<string, unknown>>;
  if (!items.every((i) => i && str(i.id) && str(i.kind, 40) && str(i.summary, 500))) return undefined;
  return {
    app: t.app as NetworkAppId,
    memberId: t.memberId,
    messageId: t.messageId,
    context: {
      firstName: (c.firstName as string | null) ?? null,
      city: (c.city as string | null) ?? null,
      state: c.state as TurnContext["state"],
      stateFrom: (c.stateFrom as string | null) ?? null,
      stateUntil: (c.stateUntil as string | null) ?? null,
      facets: c.facets as string[],
      activeItems: items.map((i) => ({ id: i.id as string, kind: i.kind as string, summary: i.summary as string })),
      singlePlayer: c.singlePlayer,
    },
  };
}
