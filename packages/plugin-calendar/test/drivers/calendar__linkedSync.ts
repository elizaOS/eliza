// spec/calendar/linkedSync.md, "A control transition checks revision and writes its receipt atomically"; spec/calendar/linkedSync.md, "Failed control writes preserve the previously committed row"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/calendar__linkedSync.conformance.ts";
import type { ControlLedger, ControlOp, ControlProof, Event } from "../../gen/calendar__linkedSync.ts";
import { linkedCalendarControl, type LinkedCalendarControlRequest, type LinkedCalendarDestination } from "@elizaos/plugin-calendar-client";
import { memoryCalendarLinkStorage } from "../support/calendar-link-storage.ts";

interface Observed {
  readonly revision: number;
  readonly paused: boolean;
  readonly destination: number;
  readonly pendingLink: number;
}

type Control = Effect.Success<ReturnType<typeof linkedCalendarControl>>;
type Commit = Extract<Event, { type: "commitReviewed" }>;

const operations: Record<ControlOp, LinkedCalendarControlRequest["operation"]> = {
  PauseControl: "pause", SelectControl: "select", ResumeControl: "resume", RecoverControl: "recover",
};
const destinationOf = (id: number): LinkedCalendarDestination => ({ connectorAccountId: "account", providerCalendarId: `dest-${id}` });
const numbered = (text: string | undefined, prefix: string) => text === undefined || !text.startsWith(prefix) ? 0 : Number(text.slice(prefix.length));

let failWrites = false;
let proof: ControlProof | undefined;
let control: Control | undefined;
let latest: { readonly key: number; readonly fingerprint: number; readonly request: LinkedCalendarControlRequest } | undefined;
let keys = 0;
const tokens = new Map<number, string>();
const references = new Map<number, string>();

const storage = memoryCalendarLinkStorage(() => failWrites);

const open = () => Effect.runPromise(linkedCalendarControl({
  agentId: "agent",
  storage,
  authority: () => proof?.authority ?? true,
  verifyDestination: () => {
    const verified = proof?.destinationVerified ?? true;
    return Promise.resolve({ ownerSource: verified, writable: verified, sameSource: verified, sameSelectionVersion: verified, approvedEmail: verified });
  },
  recoverDispatch: () => Promise.resolve({ linkExact: proof?.linkExact ?? false, outcome: proof?.recoverySettled ? "landed" : "unresolved" }),
  bootstrap: () => Promise.resolve(),
  dispatchRunning: () => proof?.dispatchActive ?? false,
}));

function requestFor(event: Commit, idempotencyKey: string): LinkedCalendarControlRequest {
  const base = { expectedRevision: event.proof.expectedRevision, idempotencyKey, review: `fingerprint-${event.fingerprint}` };
  const operation = operations[event.op];
  if (operation === "select") {
    return { ...base, operation, destination: event.proof.wantsDestination > 0 ? destinationOf(event.proof.wantsDestination) : null };
  }
  if (operation === "recover") return { ...base, operation, dispatchReference: references.get(event.proof.capturedToken) ?? `unissued-${event.proof.capturedToken}` };
  return { ...base, operation };
}

async function commit(event: Commit): Promise<"accepted" | "refused"> {
  proof = event.proof;
  control = await open();
  const sameKey = latest?.key === event.operationKey;
  const key = sameKey && latest !== undefined ? latest.request.idempotencyKey : `key-${event.operationKey}-${++keys}`;
  const request = sameKey && latest !== undefined && latest.fingerprint === event.fingerprint ? latest.request
    : requestFor(event, event.proof.lexicalRequest ? key : "");
  const foreign = (state: "clean" | "paused") => Effect.runPromise(control!.recordMapping({ linkId: "foreign", localEventId: "foreign-event", destination: destinationOf(999),
    providerEventId: "p", handoffKey: "k", localOnly: false, staged: false, state }));
  if (!event.proof.mappingsCompatible) await foreign("clean");
  failWrites = !event.casSaved;
  const outcome = await Effect.runPromise(control.commit(request).pipe(
    Effect.map((done) => done.receipt.replayed ? "refused" as const : "accepted" as const),
    Effect.catch((error) => Effect.succeed(error._tag === "LinkedControlRefused" && error.code === "LINKED_CALENDAR_CONTROL_WRITE_FAILED" ? "accepted" as const : "refused" as const)),
  )).finally(() => { failWrites = false; });
  if (!event.proof.mappingsCompatible) await foreign("paused");
  if (outcome === "accepted" && event.casSaved) latest = { key: event.operationKey, fingerprint: event.fingerprint, request };
  return outcome;
}

async function acquire(event: Extract<Event, { type: "acquirePending" }>): Promise<"accepted" | "refused"> {
  const held = control!;
  return Effect.runPromise(held.acquireDispatch(event.expectedRevision, event.linkId > 0 ? `link-${event.linkId}` : "", destinationOf(event.dispatchDestination)).pipe(
    Effect.flatMap((token) => Effect.map(held.read(), (now) => {
      tokens.set(event.token, token);
      references.set(event.token, now.pendingDispatchReference ?? "");
      return "accepted" as const;
    })),
    Effect.catch(() => Effect.succeed("refused" as const)),
  ));
}

async function send(event: Event): Promise<"accepted" | "refused"> {
  switch (event.type) {
    case "commitReviewed":
      return commit(event);
    case "acquirePending":
      return acquire(event);
    case "settleOwned":
      return Effect.runPromise(control!.settleDispatch(tokens.get(event.token) ?? `unknown-${event.token}`).pipe(
        Effect.as("accepted" as const),
        Effect.catch(() => Effect.succeed("refused" as const)),
      ));
  }
}

export const driver: Driver<Observed> = {
  async reset() {
    storage.reset();
    failWrites = false;
    proof = undefined;
    latest = undefined;
    keys = 0;
    tokens.clear();
    references.clear();
    control = await open();
  },
  dispatch: (_key, event) => send(event),
  async observe() {
    const current = await Effect.runPromise(control!.read());
    return {
      revision: current.revision,
      paused: current.paused,
      destination: numbered(current.destination?.providerCalendarId, "dest-"),
      pendingLink: numbered(current.pendingLinkId ?? undefined, "link-"),
    };
  },
};

export const options: Options<Observed> = {
  keys: ["agent"],
  view: (state: ControlLedger) => ({
    revision: state.activeControl.revision,
    paused: state.activeControl.paused,
    destination: state.activeControl.destination,
    pendingLink: state.activeControl.pendingLink,
  }),
};
