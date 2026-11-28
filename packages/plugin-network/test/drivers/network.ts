// spec/network/index.md, "Only the authenticated turn may request a state write or relay"; spec/network/index.md, "A successful Network action requires its own matching receipt"
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { ActionResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import { Redacted } from "effect";
import type { Driver, Options } from "../../gen/network.conformance.ts";
import type {
  Availability,
  AvailabilityCue,
  AvailabilityRequest,
  AvailabilityWindow,
  Event,
  MemberTurn,
  NetworkAction,
  NetworkEffect,
  NetworkOperation,
  NetworkOutcome,
} from "../../gen/network.ts";
import { createNetworkEdgePlugin, svcVerify } from "../../src/index.vibe";

interface PausedServiceCall {
  readonly path: "/internal/set-state" | "/internal/relay";
  readonly respond: PromiseWithResolvers<unknown>;
}

interface EntitySlot {
  state: NetworkOperation;
  lastOut: NetworkEffect[];
  paused: PausedServiceCall | undefined;
  nextPaused: PromiseWithResolvers<PausedServiceCall> | undefined;
  pendingAction: Promise<ActionResult | undefined> | undefined;
}

const SECRET = "network-conformance-secret-with-32-bytes";
const STATE_NAME: Readonly<Record<Availability, "open" | "busy" | "traveling" | "paused">> = {
  OpenAvailability: "open",
  BusyAvailability: "busy",
  TravelingAvailability: "traveling",
  PausedAvailability: "paused",
};

let server: Server | undefined;
let baseUrl = "";
let runEpoch = 0;
const slots = new Map<string, EntitySlot>();

function initialOperation(): NetworkOperation {
  return {
    turn: {
      memberId: "",
      app: "NtwrkApp",
      routeGeneration: 0,
      messageId: "",
      activeItemIds: ["match"],
      messageUnits: [98, 117, 115, 121],
    },
    operation: { tag: "RelayToActiveItem", itemId: "", messageUnits: [] },
    phase: "NetworkCold",
    result: { tag: "NetworkPending" },
  };
}

function slotOf(key: string): EntitySlot {
  let slot = slots.get(key);
  if (!slot) {
    slot = {
      state: initialOperation(),
      lastOut: [],
      paused: undefined,
      nextPaused: undefined,
      pendingAction: undefined,
    };
    slots.set(key, slot);
  }
  return slot;
}

function decodeUnits(units: readonly number[]): string {
  return String.fromCharCode(...units);
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameTurn(a: MemberTurn, b: MemberTurn): boolean {
  return (
    a.memberId === b.memberId
    && a.app === b.app
    && a.routeGeneration === b.routeGeneration
    && a.messageId === b.messageId
    && a.activeItemIds.length === b.activeItemIds.length
    && a.activeItemIds.every((v, i) => v === b.activeItemIds[i])
    && sameNumbers(a.messageUnits, b.messageUnits)
  );
}

function sameAction(a: NetworkAction, b: NetworkAction): boolean {
  if (a.tag !== b.tag) return false;
  if (a.tag === "SetAvailability" && b.tag === "SetAvailability") {
    return (
      a.availability === b.availability
      && a.window.begins === b.window.begins
      && a.window.ends === b.window.ends
    );
  }
  if (a.tag === "RelayToActiveItem" && b.tag === "RelayToActiveItem") {
    return a.itemId === b.itemId && sameNumbers(a.messageUnits, b.messageUnits);
  }
  return false;
}

function cueSupports(wanted: Availability, cue: AvailabilityCue): boolean {
  if (wanted === "OpenAvailability") return cue === "OpenCue";
  if (wanted === "TravelingAvailability") return cue === "TravelCue";
  return cue === "BusyCue" || cue === "PauseCue";
}

function exactQuote(req: AvailabilityRequest): boolean {
  const { bodyUnits, quoteUnits, quoteOffset } = req.words;
  if (quoteUnits.length === 0 || quoteOffset < 0 || quoteOffset + quoteUnits.length > bodyUnits.length) {
    return false;
  }
  return quoteUnits.every((unit, i) => bodyUnits[quoteOffset + i] === unit);
}

function computeWindow(req: AvailabilityRequest): AvailabilityWindow {
  const begins = req.words.statedWindow.begins === -1 ? req.suggested.begins : req.words.statedWindow.begins;
  const ends = req.words.statedWindow.ends === -1 ? req.suggested.ends : req.words.statedWindow.ends;
  if (req.requested === "OpenAvailability") return { begins: -1, ends: -1 };
  return { begins: begins === req.today ? -1 : begins, ends };
}

function requestValid(req: AvailabilityRequest): boolean {
  const begins = req.words.statedWindow.begins === -1 ? req.suggested.begins : req.words.statedWindow.begins;
  const ends = req.words.statedWindow.ends === -1 ? req.suggested.ends : req.words.statedWindow.ends;
  return (
    req.today >= 0
    && exactQuote(req)
    && cueSupports(req.requested, req.words.cue)
    && (begins === -1 || begins >= req.today)
    && (ends === -1 || ends >= req.today)
    && (begins <= req.today || ends === -1 || begins < ends)
  );
}

function receiptValid(operation: NetworkAction, result: NetworkOutcome): boolean {
  if (operation.tag === "SetAvailability") {
    if (result.tag === "AvailabilityCommitted") return result.eventId !== "";
    return result.tag === "AvailabilityUnchanged";
  }
  if (result.tag === "RelayDelivered") return result.deliveryRequestId !== "";
  return (
    result.tag === "RelayHeld"
    || result.tag === "RelayBlocked"
    || result.tag === "RelayNotRequested"
    || result.tag === "RelayUnconfirmed"
  );
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}

let activeKeyByRequestId = new Map<string, { readonly epoch: number; readonly key: string }>();

async function ensureServer(): Promise<string> {
  if (server) return baseUrl;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      const url = req.url ?? "";
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = {
        get: (name: string) => {
          const val = req.headers[name.toLowerCase()];
          return Array.isArray(val) ? (val[0] ?? null) : (val ?? null);
        },
      };
      void svcVerify(SECRET, { method: req.method ?? "POST", path: url, headers, body }).then((verified) => {
        if (!verified.ok) {
          writeJson(res, 401, { error: verified.reason });
          return;
        }
        const entry = activeKeyByRequestId.get(verified.id);
        if (!entry || entry.epoch !== runEpoch || (url !== "/internal/set-state" && url !== "/internal/relay")) {
          writeJson(res, 404, { error: "unknown request" });
          return;
        }
        const slot = slotOf(entry.key);
        const respond = Promise.withResolvers<unknown>();
        const paused: PausedServiceCall = { path: url, respond };
        slot.paused = paused;
        const waiter = slot.nextPaused;
        slot.nextPaused = undefined;
        waiter?.resolve(paused);
        void respond.promise.then((reply) => {
          if (reply === undefined) {
            if (!res.writableEnded && !res.destroyed) {
              res.writeHead(499, { connection: "close" });
              res.end();
            }
            return;
          }
          writeJson(res, 200, reply);
        });
      });
    });
  });
  server.keepAliveTimeout = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

async function cleanupSlot(slot: EntitySlot): Promise<void> {
  slot.paused?.respond.resolve(undefined);
  const pending = slot.pendingAction;
  slot.paused = undefined;
  slot.nextPaused = undefined;
  slot.pendingAction = undefined;
  if (pending) await pending.catch(() => undefined);
}

function outcomeToWire(operation: NetworkAction, result: NetworkOutcome): unknown {
  if (operation.tag === "SetAvailability") {
    const current = STATE_NAME[operation.availability];
    return {
      eventId: result.tag === "AvailabilityCommitted" ? result.eventId : null,
      previous: "open",
      current,
      committedAt: "2026-10-14T00:00:00.000Z",
      replayed: false,
      unchanged: result.tag === "AvailabilityUnchanged",
    };
  }
  if (result.tag === "RelayHeld") return { decision: "hold", senderNotice: "Held.", delivered: false, replayed: false };
  if (result.tag === "RelayBlocked") return { decision: "block", senderNotice: "Blocked.", delivered: false, replayed: false };
  if (result.tag === "RelayNotRequested") return { decision: "none", senderNotice: "None.", delivered: false, replayed: false };
  if (result.tag === "RelayUnconfirmed") return { decision: "pass", senderNotice: "Pending.", delivered: false, replayed: false };
  return { decision: "pass", senderNotice: "Passed on.", delivered: true, replayed: false };
}

function isoDateOrUndefined(epochDay: number): string | undefined {
  return epochDay < 0 ? undefined : new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

export const driver: Driver & AsyncDisposable = {
  async reset() {
    runEpoch += 1;
    for (const slot of slots.values()) {
      await cleanupSlot(slot);
    }
    slots.clear();
    activeKeyByRequestId = new Map();
    await ensureServer();
  },

  async dispatch(key: string, event: Event, by?: unknown) {
    const slot = slotOf(key);
    slot.lastOut = [];
    const root = await ensureServer();

    if (event.type === "bindNetworkTurn") {
      if (
        by !== "NetworkHost"
        || slot.state.phase !== "NetworkCold"
        || event.turn.memberId === ""
        || event.turn.messageId === ""
        || event.turn.routeGeneration <= 0
      ) {
        return "refused";
      }
      slot.state = { ...slot.state, turn: structuredClone(event.turn), phase: "NetworkReady" };
      return "accepted";
    }

    if (event.type === "setNetworkAvailability") {
      const req = event.availabilityRequest;
      if (
        by !== "NetworkHost"
        || slot.state.phase !== "NetworkReady"
        || !sameNumbers(req.words.bodyUnits, slot.state.turn.messageUnits)
        || !requestValid(req)
      ) {
        return "refused";
      }
      const turn = slot.state.turn;
      const effective: Availability =
        req.requested === "PausedAvailability" && req.words.cue === "BusyCue"
          ? "BusyAvailability"
          : req.requested;
      const window = computeWindow(req);
      const operation: NetworkAction = { tag: "SetAvailability", availability: effective, window };

      const text = decodeUnits(turn.messageUnits);
      const idempotencyKey = `state:${turn.memberId}:${turn.messageId}`;
      activeKeyByRequestId.set(idempotencyKey, { epoch: runEpoch, key });
      const plugin = createNetworkEdgePlugin({
        service: { baseUrl: root, secret: Redacted.make(SECRET) },
        authority: {
          turn,
          channel: "blooio",
          text,
          timeZone: "UTC",
          singlePlayer: false,
        },
      });
      const setStateAction = plugin.actions?.find((a) => a.name === "SET_STATE");
      if (!setStateAction) throw new Error("SET_STATE action missing");
      const message = { id: turn.messageId, content: { text } } as unknown as Memory;
      const waitPaused = Promise.withResolvers<PausedServiceCall>();
      slot.nextPaused = waitPaused;
      const run = setStateAction.handler(
        {} as IAgentRuntime,
        message,
        {} as State,
        {
          parameters: {
            state: STATE_NAME[effective],
            evidence: decodeUnits(req.words.quoteUnits),
            ...(isoDateOrUndefined(window.begins) !== undefined ? { from: isoDateOrUndefined(window.begins) } : {}),
            ...(isoDateOrUndefined(window.ends) !== undefined ? { until: isoDateOrUndefined(window.ends) } : {}),
          },
        },
      );
      void run.catch(() => undefined);
      slot.pendingAction = run;
      const paused = await Promise.race([
        waitPaused.promise.then((p) => ({ ok: true as const, paused: p })),
        run.then(() => ({ ok: false as const }), () => ({ ok: false as const })),
      ]);
      if (!paused.ok) {
        slot.nextPaused = undefined;
        slot.pendingAction = undefined;
      }
      slot.state = { ...slot.state, operation, phase: "NetworkAwaitingReceipt" };
      slot.lastOut = [{ tag: "SendNetworkRequest", turn: structuredClone(turn), operation: structuredClone(operation) }];
      return "accepted";
    }

    if (event.type === "relayNetwork") {
      const turn = slot.state.turn;
      if (
        by !== "NetworkHost"
        || slot.state.phase !== "NetworkReady"
        || turn.messageUnits.length === 0
        || turn.messageUnits.length > 2000
        || (event.itemId !== "" && !turn.activeItemIds.includes(event.itemId))
      ) {
        return "refused";
      }
      const text = decodeUnits(turn.messageUnits);
      activeKeyByRequestId.set(turn.messageId, { epoch: runEpoch, key });
      const plugin = createNetworkEdgePlugin({
        service: { baseUrl: root, secret: Redacted.make(SECRET) },
        authority: {
          turn,
          channel: "blooio",
          text,
          timeZone: "UTC",
          singlePlayer: false,
        },
      });
      const relayAction = plugin.actions?.find((a) => a.name === "RELAY");
      if (!relayAction) throw new Error("RELAY action missing");
      const message = { id: turn.messageId, content: { text } } as unknown as Memory;
      const waitPaused = Promise.withResolvers<PausedServiceCall>();
      slot.nextPaused = waitPaused;
      const run = relayAction.handler(
        {} as IAgentRuntime,
        message,
        {} as State,
        { parameters: event.itemId === "" ? {} : { itemId: event.itemId } },
      );
      void run.catch(() => undefined);
      slot.pendingAction = run;
      const reached = await Promise.race([
        waitPaused.promise.then((p) => ({ ok: true as const, paused: p })),
        run.then(() => ({ ok: false as const }), () => ({ ok: false as const })),
      ]);
      if (!reached.ok) throw new Error("RELAY action did not dispatch signed HTTP request");
      const operation: NetworkAction = {
        tag: "RelayToActiveItem",
        itemId: event.itemId,
        messageUnits: [...turn.messageUnits],
      };
      slot.state = { ...slot.state, operation, phase: "NetworkAwaitingReceipt" };
      slot.lastOut = [{ tag: "SendNetworkRequest", turn: structuredClone(turn), operation: structuredClone(operation) }];
      return "accepted";
    }

    if (event.type === "observeNetworkAction") {
      if (
        by !== "NetworkService"
        || slot.state.phase !== "NetworkAwaitingReceipt"
        || !sameTurn(slot.state.turn, event.turn)
        || !sameAction(slot.state.operation, event.operation)
        || !receiptValid(event.operation, event.result)
      ) {
        return "refused";
      }
      const paused = slot.paused;
      const pending = slot.pendingAction;
      slot.paused = undefined;
      slot.pendingAction = undefined;
      if (paused) {
        paused.respond.resolve(outcomeToWire(event.operation, event.result));
      }
      if (pending) {
        const res = await pending;
        if (event.operation.tag === "RelayToActiveItem" && res !== undefined) {
          const expectedSuccess = event.result.tag === "RelayDelivered";
          if (res.success !== expectedSuccess) {
            throw new Error(`RELAY result mismatch: expected success=${String(expectedSuccess)}, got ${String(res.success)}`);
          }
        }
      }
      slot.state = { ...slot.state, phase: "NetworkComplete", result: structuredClone(event.result) };
      return "accepted";
    }

    return "refused";
  },

  observe(key: string): NetworkOperation {
    return structuredClone(slotOf(key).state);
  },

  observeOutput(key: string): NetworkEffect[] {
    return structuredClone(slotOf(key).lastOut);
  },

  async [Symbol.asyncDispose]() {
    for (const slot of slots.values()) {
      await cleanupSlot(slot);
    }
    slots.clear();
    if (server) {
      const closing = server;
      server = undefined;
      closing.closeAllConnections();
      await new Promise<void>((resolve) => { closing.close(() => resolve()); });
    }
  },
};

export const options: Options = { keys: ["a", "b"], walks: 20, steps: 20 };
