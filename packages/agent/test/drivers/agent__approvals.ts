// spec/agent/approvals.md, "Story: Resolve what I reviewed, only on the screen"; spec/agent/approvals.md, "The list shows at most 500 requests of the asked phase, newest first, and changes nothing"
import { Effect } from "effect";
import { logger, type IDatabaseAdapter } from "@elizaos/core";
import type { Driver, Options } from "../../gen/agent__approvals.conformance.ts";
import type { ApprovalKind, Event, LedgerResult, Queue, Reply, ResolveKind } from "../../gen/agent__approvals.ts";
import { approvalQueue, type ApprovalQueue, type ApprovalResolution, type CalendarApprovalExecutor, type LedgerOutcome } from "../../src/approvals/queue.vibe";
import { openDeviceStorage } from "../../src/storage/index.vibe";
import { scratchDirectory, type Scratch } from "../support/scratch.ts";

const cacheKey = "owner-approvals";
const day = 86_400_000;
const start = Date.parse("2026-03-02T09:00:00.000Z");
const empty: Queue = { rows: {}, newestFirst: [] };
const actionOf = { CalendarChange: "schedule_event", OtherChange: "send_message" } as const satisfies Record<ApprovalKind, string>;
const kindsBack: Record<string, ResolveKind> = {
  succeeded: "KindSucceeded", rejected: "KindRejected", invalidated: "KindInvalidated", retryable: "KindRetryable", blocked: "KindBlocked",
};

let opened: { readonly scratch: Scratch; readonly adapter: IDatabaseAdapter } | undefined;
let queue: ApprovalQueue | undefined;
let now = start;
let ledger: { readonly ready: boolean; readonly result: LedgerResult; calls: number } = { ready: false, result: "ChangeSucceeded", calls: 0 };
let output: Reply[] = [];
const expiries = new Map<string, number>();
const revisions = new Map<string, string>();

const executor: CalendarApprovalExecutor = {
  execute: (request) => {
    ledger.calls++;
    const outcome: LedgerOutcome = { result: ledger.result, text: `Calendar change ${request.id}: ${ledger.result}` };
    return Promise.resolve(outcome);
  },
};

async function store(): Promise<IDatabaseAdapter> {
  if (opened === undefined) {
    const scratch = await scratchDirectory("approvals-driver");
    const { adapter } = await openDeviceStorage({ stateDirectory: scratch.file("memory"), persistMemory: false, account: null, embeddingDimensions: 0 });
    opened = { scratch, adapter };
  }
  return opened.adapter;
}

function queueOver(adapter: IDatabaseAdapter): ApprovalQueue {
  return approvalQueue({
    getCache: async <T>(key: string) => (await adapter.getCaches<T>([key])).get(key),
    setCache: <T>(key: string, value: T) => adapter.setCaches<T>([{ key, value }]),
    executor: () => ledger.ready ? executor : undefined,
    logger,
    now: Effect.sync(() => now),
  });
}

async function stored(): Promise<Queue> {
  const kept = (await opened!.adapter.getCaches<{ queue: Queue }>([cacheKey])).get(cacheKey);
  return kept === undefined ? empty : kept.queue;
}

async function remember(): Promise<void> {
  const held = await stored();
  for (const record of await Effect.runPromise(queue!.list({ phases: { tag: "AllPhases" }, limit: 500 }))) {
    revisions.set(`${record.id}#${held.rows[`$${record.id}`].revision}`, record.revision);
  }
}

function replyOf(id: string, resolution: ApprovalResolution): Reply {
  if (resolution.kind === "refused") return { tag: "Refused", id, refusal: resolution.refusal };
  const kind = kindsBack[resolution.reply.kind];
  if (kind === undefined) throw new Error(`The queue answered ${id} with an unknown kind ${resolution.reply.kind}`);
  return { tag: "Resolved", id: resolution.reply.requestId, kind };
}

async function resolve(event: Extract<Event, { type: "resolve" }>): Promise<"accepted"> {
  ledger = { ready: event.executorReady, result: event.result, calls: 0 };
  const revision = revisions.get(`${event.id}#${event.reviewed}`) ?? `unreviewed ${event.reviewed}`;
  const decision = event.decision === "Approve" ? "approve" : "reject";
  const resolution = await Effect.runPromise(queue!.resolve(event.id, decision, revision));
  const reply = replyOf(event.id, resolution);
  const mayRun = reply.tag === "Resolved" && reply.kind !== "KindRejected";
  if (ledger.calls > (mayRun ? 1 : 0)) throw new Error(`The executor ran ${ledger.calls} times for ${JSON.stringify(reply)}`);
  output = [reply];
  return "accepted";
}

async function send(event: Event): Promise<"accepted" | "refused"> {
  now += 1_000;
  output = [];
  switch (event.type) {
    case "request": {
      const expiresAt = now + day;
      const row = {
        id: event.id, subjectUserId: "owner", requestedBy: "agent", action: actionOf[event.kind],
        payload: { title: `Request ${event.id}` }, reason: "The agent asks before changing the calendar", expiresAt: new Date(expiresAt).toISOString(),
      };
      const made = await Effect.runPromise(queue!.request(row).pipe(
        Effect.as("accepted" as const),
        Effect.catchTag("RequestRefused", () => Effect.succeed("refused" as const)),
      ));
      if (made === "accepted") expiries.set(event.id, expiresAt);
      return made;
    }
    case "lapse": {
      const base = now;
      now = Math.max(now, expiries.get(event.id) ?? now);
      const lapsed = await Effect.runPromise(queue!.lapseIfDue(event.id)).finally(() => { now = base; });
      return lapsed ? "accepted" : "refused";
    }
    case "list":
      return await Effect.runPromise(queue!.list(event.query).pipe(
        Effect.map((records) => {
          output = [{ tag: "Listed", ids: records.map((record) => record.id), phases: event.query.phases }];
          return "accepted" as const;
        }),
        Effect.catchTag("PageRefused", () => Effect.succeed("refused" as const)),
      ));
    case "resolve":
      return await resolve(event);
  }
}

export const driver: Driver<Queue> & { [Symbol.asyncDispose](): Promise<void> } = {
  async reset() {
    const adapter = await store();
    await adapter.deleteCaches([cacheKey]);
    now = start;
    ledger = { ready: false, result: "ChangeSucceeded", calls: 0 };
    output = [];
    expiries.clear();
    revisions.clear();
    queue = queueOver(adapter);
  },
  async dispatch(_key, event) {
    const did = await send(event);
    await remember();
    return did;
  },
  observe: () => stored(),
  observeOutput: () => output,
  async [Symbol.asyncDispose]() {
    queue = undefined;
    const held = opened;
    opened = undefined;
    if (held === undefined) return;
    await held.adapter.close();
    await held.scratch.remove();
  },
};

export const options: Options<Queue> = { keys: ["queue"] };
