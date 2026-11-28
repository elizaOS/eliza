// spec/agent/deviceActions/index.md, "Story: Enroll my device and revoke it"; spec/agent/deviceActions/index.md, "Story: Approve a device request once and learn exactly what happened"; spec/agent/deviceActions/index.md, "Story: Complete the original request with the result I shared"
import { Clock, Effect } from "effect";
import type { IDatabaseAdapter } from "@elizaos/core";
import type { DeviceOperationReceipt } from "@elizaos/agent";
import type { Driver, Options } from "../../gen/agent__deviceActions.conformance.ts";
import type { DeviceRequest, Event, ReceiptOutcome } from "../../gen/agent__deviceActions.ts";
import type { SessionOwner } from "../../gen/core__sessions.ts";
import {
  changeEnrollment, enrollment, offerRequest, openRequest, recordRequestClaim, recordRequestDecision, recordRequestReceipt, recordRequestReview, requestSnapshot,
  type RequestEvent, type RequestTerms,
} from "../../src/device-actions/store.vibe";
import { openDeviceStorage } from "../../src/storage/index.vibe";
import { scratchDirectory, type Scratch } from "../support/scratch.ts";

interface Sql {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

const wallClock = Date.now;
const wrongAttemptId = "00000000-0000-0000-0000-000000000000";

const defaultTerms: RequestTerms = {
  operation: { type: "calendar.create.v1", title: "Dentist" },
  binding: "NoBinding",
  boundProfile: { tag: "NoRevisionRead" },
  need: { required: ["CalendarCreateV1"], oneOf: [] },
};

const providerReceipts: Record<ReceiptOutcome, DeviceOperationReceipt> = {
  ReportedApplied: { outcome: "applied", operationId: "op-1", result: { applied: true } },
  ReportedNothingRan: { outcome: "failed", code: "not_dispatched" },
  ReportedUnknown: { outcome: "unknown", code: "unknown_outcome" },
};

let opened: { readonly scratch: Scratch; readonly adapter: IDatabaseAdapter } | undefined;
let now = 0;
let activeProposalId: string | undefined;
let activeClaim: { readonly modelAttemptId: number; readonly wireAttemptId: string } | undefined;

Date.now = () => now;

const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.sync(() => now),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  sleep: () => Effect.void,
};

const run = <A, E>(work: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provideService(work, Clock.Clock, clock));

function isSessionOwner(raw: unknown): raw is SessionOwner {
  return typeof raw === "object" && raw !== null
    && "agentId" in raw && typeof raw.agentId === "string"
    && "actorId" in raw && typeof raw.actorId === "string"
    && "connector" in raw && typeof raw.connector === "string";
}

async function store(): Promise<IDatabaseAdapter> {
  if (opened === undefined) {
    const scratch = await scratchDirectory("device-actions-driver");
    const { adapter } = await openDeviceStorage({
      stateDirectory: scratch.file("memory"), persistMemory: false, account: null, embeddingDimensions: 0,
    });
    opened = { scratch, adapter };
  }
  return opened.adapter;
}

async function clearTables(adapter: IDatabaseAdapter): Promise<void> {
  await adapter.transaction(async (tx) => {
    const sql = (await tx.getConnection()) as Sql;
    await sql.query("DELETE FROM device_requests");
    await sql.query("DELETE FROM device_enrollment");
  });
}

async function stepRequest(adapter: IDatabaseAdapter, proposalId: string, event: RequestEvent, by: SessionOwner): Promise<"accepted" | "refused"> {
  const record = await run(openRequest(adapter, proposalId));
  if (record === undefined) return "refused";
  return await run(record.machine.send(event, by).pipe(
    Effect.as("accepted" as const),
    Effect.catchTag("Rejected", () => Effect.succeed("refused" as const)),
  ));
}

async function send(event: Event, rawBy: unknown): Promise<"accepted" | "refused"> {
  if (!isSessionOwner(rawBy)) return "refused";
  const by = rawBy;
  const adapter = await store();
  switch (event.type) {
    case "registerDevice": {
      if (activeProposalId !== undefined) {
        const snapshot = await run(requestSnapshot(adapter, activeProposalId));
        if (snapshot !== undefined && snapshot.state.enrollment.tag === "Revoked") {
          return await stepRequest(adapter, activeProposalId, event, by);
        }
      }
      return await run(changeEnrollment(adapter, event, by).pipe(
        Effect.as("accepted" as const),
        Effect.catchTag("Rejected", () => Effect.succeed("refused" as const)),
      ));
    }
    case "revokeEnrollment":
      return await run(changeEnrollment(adapter, event, by).pipe(
        Effect.as("accepted" as const),
        Effect.catchTag("Rejected", () => Effect.succeed("refused" as const)),
      ));
    case "offer": {
      if (activeProposalId !== undefined) {
        return await stepRequest(adapter, activeProposalId, event, by);
      }
      const offered = await run(offerRequest(adapter, event, by, defaultTerms).pipe(
        Effect.as("accepted" as const),
        Effect.catchTag("Rejected", () => Effect.succeed("refused" as const)),
        Effect.catchTag("ProposalIdTaken", () => Effect.succeed("refused" as const)),
      ));
      if (offered === "accepted") activeProposalId = event.proposalId;
      return offered;
    }
    case "decide": {
      if (activeProposalId === undefined) return "refused";
      const decided = await run(recordRequestDecision(adapter, {
        proposalId: activeProposalId, digest: event.digest, by, approved: event.approved,
      }));
      return decided.kind === "decided" ? "accepted" : "refused";
    }
    case "claim": {
      if (activeProposalId === undefined) return "refused";
      const claimed = await run(recordRequestClaim(adapter, {
        proposalId: activeProposalId, digest: event.digest, by,
      }));
      if (claimed.kind !== "claimed") return "refused";
      activeClaim = claimed.binding;
      return "accepted";
    }
    case "receipt": {
      if (activeProposalId === undefined) return "refused";
      const recorded = await run(recordRequestReceipt(adapter, {
        proposalId: activeProposalId, by, event, providerReceipt: providerReceipts[event.reportedOutcome],
      }));
      return recorded.kind === "recorded" ? "accepted" : "refused";
    }
    case "reconcile": {
      if (activeProposalId === undefined) return "refused";
      const attemptId = activeClaim !== undefined && activeClaim.modelAttemptId === event.attemptId
        ? activeClaim.wireAttemptId : wrongAttemptId;
      const reviewed = await run(recordRequestReview(adapter, {
        proposalId: activeProposalId, digest: event.digest, by, attemptId, review: event.review,
      }));
      return reviewed.kind === "reviewed" ? "accepted" : "refused";
    }
    case "elapse": {
      if (event.elapsed < 0) return "refused";
      if (activeProposalId === undefined) {
        now += event.elapsed;
        return "accepted";
      }
      const moved = await stepRequest(adapter, activeProposalId, event, by);
      if (moved === "accepted") now += event.elapsed;
      return moved;
    }
    case "expire":
    case "endTurn":
    case "claimCompletion":
    case "prepareCompletion":
    case "deliverCompletion":
    case "failCompletion":
    case "cancelCompletion":
      return activeProposalId === undefined ? "refused" : await stepRequest(adapter, activeProposalId, event, by);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

async function observe(): Promise<DeviceRequest> {
  const adapter = await store();
  if (activeProposalId === undefined) return await run(enrollment(adapter));
  const snapshot = await run(requestSnapshot(adapter, activeProposalId));
  if (snapshot === undefined) throw new Error(`The device request ${activeProposalId} is gone`);
  return snapshot.state;
}

export const driver: Driver<DeviceRequest> & AsyncDisposable = {
  async reset() {
    const adapter = await store();
    await clearTables(adapter);
    now = 0;
    activeProposalId = undefined;
    activeClaim = undefined;
  },
  dispatch: (_key, event, by) => send(event, by),
  observe: () => observe(),
  async [Symbol.asyncDispose]() {
    activeProposalId = undefined;
    activeClaim = undefined;
    Date.now = wallClock;
    const held = opened;
    opened = undefined;
    if (held === undefined) return;
    await held.adapter.close();
    await held.scratch.remove();
  },
};

export const options: Options<DeviceRequest> = {
  keys: ["device"],
};
