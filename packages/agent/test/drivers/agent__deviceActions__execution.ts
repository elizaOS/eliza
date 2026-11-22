// spec/agent/deviceActions/execution.md, "Story: Approve a device operation on the screen that reviewed it"; spec/agent/deviceActions/execution.md, "Story: Preserve a device result when the screen retires"
import { Cause, Effect, Exit } from "effect";
import type { Driver, Options } from "../../gen/agent__deviceActions__execution.conformance.ts";
import type { DeviceAttempt, DeviceEffect, Event, JournalAnswer } from "../../gen/agent__deviceActions__execution.ts";
import { openAttempt, reserve, type AttemptBinding, type JournaledAttempt, type JournalEntry, type JournalIdentity } from "../../src/client/device-execution.vibe";
import { fileJournal, type FileJournal } from "../support/device-journal.ts";
import { scratchDirectory, type Scratch } from "../support/scratch.ts";

const identity: JournalIdentity = { ownerId: "owner-1", agentId: "agent-1", origin: "http://127.0.0.1", installationId: "agent-1", enrollmentId: "enrollment-1" };
const operation = JSON.stringify({ type: "calendar.create.v1", title: "Dentist" });

let opened: { readonly scratch: Scratch; readonly journal: FileJournal } | undefined;
const attempts = new Map<string, JournaledAttempt>();
const outputs = new Map<string, DeviceEffect[]>();

const bindingFor = (key: string): AttemptBinding => ({ proposalId: `proposal-${key}`, digest: `digest-${key}`, operationId: "op1", operation });

async function journal(): Promise<FileJournal> {
  if (opened === undefined) {
    const scratch = await scratchDirectory("device-execution-driver");
    opened = { scratch, journal: await fileJournal(scratch.file("journal")) };
  }
  return opened.journal;
}

async function attemptFor(key: string): Promise<JournaledAttempt> {
  const found = attempts.get(key);
  if (found !== undefined) return found;
  const made = await Effect.runPromise(openAttempt(await journal(), identity, bindingFor(key)));
  attempts.set(key, made);
  return made;
}

async function seed(key: string, answer: JournalAnswer): Promise<void> {
  const store = await journal();
  const binding = bindingFor(key);
  if (answer === "NewEntry") return await store.remove(binding.proposalId);
  const earlier: DeviceAttempt = { phase: { tag: "Reserved" }, operationId: binding.operationId, attemptId: 0, authority: "Approval", retired: false, calls: 0, uploads: 0 };
  const owner = answer === "UnclaimedReservation" ? identity.ownerId : "another-owner";
  await store.put(binding.proposalId, { ...binding, ...identity, ownerId: owner, revision: 3, attempt: earlier, evidence: {}, acknowledged: false });
}

async function outcome(work: Effect.Effect<{ readonly out: DeviceEffect[] } | undefined, unknown>, key: string): Promise<"accepted" | "refused"> {
  const done = await Effect.runPromiseExit(work);
  if (Exit.isSuccess(done)) {
    if (done.value === undefined) return "refused";
    outputs.set(key, done.value.out);
    return "accepted";
  }
  const error = Cause.squash(done.cause);
  if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "Rejected") return "refused";
  throw error;
}

async function send(key: string, event: Event): Promise<"accepted" | "refused"> {
  const attempt = await attemptFor(key);
  outputs.set(key, []);
  if (event.type === "reserve" && !attempt.slot.written && event.operationId === attempt.slot.binding.operationId) {
    await seed(key, event.journal);
    return await outcome(reserve(attempt, event.check), key);
  }
  return await outcome(attempt.machine.send(event), key);
}

async function observe(key: string): Promise<DeviceAttempt> {
  const attempt = await attemptFor(key);
  if (!attempt.slot.written) return await Effect.runPromise(attempt.machine.get());
  const store = await journal();
  const entry = (await store.get(attempt.slot.binding.proposalId)) as JournalEntry;
  const reopened = await Effect.runPromise(openAttempt(store, identity, attempt.slot.binding, entry));
  return await Effect.runPromise(reopened.machine.get());
}

export const driver: Driver & { [Symbol.asyncDispose](): Promise<void> } = {
  async reset() {
    const store = await journal();
    for (const key of attempts.keys()) await store.remove(bindingFor(key).proposalId);
    attempts.clear();
    outputs.clear();
  },
  dispatch: (key, event) => send(key, event),
  observe,
  observeOutput: (key) => outputs.get(key) ?? [],
  async [Symbol.asyncDispose]() {
    const held = opened;
    opened = undefined;
    attempts.clear();
    if (held !== undefined) await held.scratch.remove();
  },
};

export const options: Options = { keys: ["a", "b"] };
