// spec/agent/deviceActions/index.md, "Story: Enroll my device and revoke it"; spec/agent/deviceActions/index.md, "Story: Approve a device request once and learn exactly what happened"; spec/agent/deviceActions/index.md, "A revoked enrollment never returns and retires every open offer"
import { Cause, Clock, Effect, Exit } from "effect";
import type { IDatabaseAdapter } from "@elizaos/core";
import type { Driver, Options } from "../../gen/agent__deviceActions.conformance.ts";
import type { DeviceRequest, Event } from "../../gen/agent__deviceActions.ts";
import type { SessionOwner } from "../../gen/core__sessions.ts";
import { changeEnrollment, enrollment, offerRequest, openRequest, type RequestTerms } from "../../src/device-actions/store.vibe";
import { openDeviceStorage } from "../../src/storage/index.vibe";
import { scratchDirectory, type Scratch } from "../support/scratch.ts";

interface Sql {
  query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

const nobody: SessionOwner = { agentId: "", actorId: "", connector: "" };
const terms: RequestTerms = {
  operation: { type: "calendar.create.v1", title: "Dentist" }, binding: "NoBinding",
  boundProfile: { tag: "NoRevisionRead" }, need: { required: ["CalendarCreateV1"], oneOf: [] },
};
const refusals = new Set(["Rejected", "ProposalIdTaken"]);

let now = 0;
const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.sync(() => now),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  sleep: () => Effect.void,
};

let opened: { readonly scratch: Scratch; readonly adapter: IDatabaseAdapter } | undefined;
const proposals = new Map<string, string>();

const run = <A, E>(work: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(Effect.provideService(work, Clock.Clock, clock));

async function outcome<A, E>(work: Effect.Effect<A, E>): Promise<"accepted" | "refused"> {
  const done = await Effect.runPromiseExit(Effect.provideService(work, Clock.Clock, clock));
  if (Exit.isSuccess(done)) return "accepted";
  const error = Cause.squash(done.cause);
  if (typeof error === "object" && error !== null && "_tag" in error && refusals.has(String(error._tag))) return "refused";
  throw error;
}

async function store(): Promise<IDatabaseAdapter> {
  if (opened === undefined) {
    const scratch = await scratchDirectory("device-actions-driver");
    const { adapter } = await openDeviceStorage({ stateDirectory: scratch.file("memory"), persistMemory: false, account: null, embeddingDimensions: 0 });
    opened = { scratch, adapter };
  }
  return opened.adapter;
}

async function sql(text: string): Promise<void> {
  await opened!.adapter.transaction(async (tx) => { await ((await tx.getConnection()) as Sql).query(text); });
}

async function send(key: string, event: Event, by: SessionOwner): Promise<"accepted" | "refused"> {
  const adapter = opened!.adapter;
  const proposalId = proposals.get(key);
  switch (event.type) {
    case "registerDevice":
    case "revokeEnrollment":
      return await outcome(changeEnrollment(adapter, event, by));
    case "elapse":
      if (event.elapsed < 0) return "refused";
      now += event.elapsed;
      return "accepted";
    case "offer":
      if (proposalId === undefined) {
        const offered = await outcome(offerRequest(adapter, event, by, terms));
        if (offered === "accepted") proposals.set(key, event.proposalId);
        return offered;
      }
  }
  if (proposalId === undefined) return "refused";
  const record = await run(openRequest(adapter, proposalId));
  if (record === undefined) throw new Error(`The device request ${proposalId} is gone`);
  return await outcome(record.machine.send(event, by));
}

async function observe(key: string): Promise<DeviceRequest> {
  const adapter = opened!.adapter;
  const proposalId = proposals.get(key);
  if (proposalId === undefined) return await run(enrollment(adapter));
  const record = await run(openRequest(adapter, proposalId));
  if (record === undefined) throw new Error(`The device request ${proposalId} is gone`);
  return await run(record.machine.get());
}

export const driver: Driver & { [Symbol.asyncDispose](): Promise<void> } = {
  async reset() {
    await store();
    await sql("DELETE FROM device_requests");
    await sql("DELETE FROM device_enrollment");
    await sql("DELETE FROM device_view_profile");
    now = 0;
    proposals.clear();
  },
  dispatch: (key, event, by) => send(key, event, (by as SessionOwner | undefined) ?? nobody),
  observe,
  async [Symbol.asyncDispose]() {
    const held = opened;
    opened = undefined;
    if (held === undefined) return;
    await held.adapter.close();
    await held.scratch.remove();
  },
};

export const options: Options = { keys: ["request"] };
