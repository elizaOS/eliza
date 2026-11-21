// spec/agent/tasks/store.md, "Story: Refuse task storage when custody cannot be verified"; spec/agent/tasks/store.md, "Story: Keep records a build cannot read"
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Redacted, Result } from "effect";
import { createInteractiveTask, ElizaError, transitionInteractiveTask, type InteractiveTask } from "@elizaos/core";
import type { Driver, Options } from "../../gen/agent__tasks__store.conformance.ts";
import type { Event, OpenEvidence, Purpose, TaskStore } from "../../gen/agent__tasks__store.ts";
import { createTaskSealer, deriveTaskKeys } from "../../src/tasks/sealing.vibe";
import {
  createTaskStore, decodeTaskRecord, holdsSlot, insertRecord, openNodeTaskDatabase, openTaskRows, storageKeySource,
  type TaskDatabaseOpener, type TaskKeySource, type TaskRecord, type TaskStoreHandle,
} from "../../src/tasks/store.vibe";
import { scratchDirectory, type Scratch } from "../support/scratch.ts";

type Outcome = "accepted" | "refused";

interface Observed {
  readonly account: string;
  readonly writer: TaskStore["writer"]["tag"];
  readonly holdsLock: boolean;
  readonly records: readonly { readonly taskId: string; readonly authentic: boolean; readonly unfinished: boolean; readonly hold: string }[];
}

interface Armed {
  fail: boolean;
  steal: boolean;
}

interface Device {
  readonly scratch: Scratch;
  readonly directory: string;
  readonly file: string;
  readonly lock: string;
  readonly key: string;
  readonly decodes: Map<string, boolean>;
  readonly armed: Armed;
  readonly store: TaskStoreHandle;
  evidence: OpenEvidence;
  probes: number;
}

const owner = { agentId: "agent-1", actorId: "owner-1", connector: { source: "device", accountId: "device" } };
const goodCustody: OpenEvidence = { privatePath: true, exclusiveLock: true, key: "KeyOk" };
let deadPid: number | undefined;
let device: Device | undefined;

const run = <A, E>(work: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(work);

async function attempt<A, E>(work: Effect.Effect<A, E>): Promise<Outcome> {
  return Result.isSuccess(await Effect.runPromise(Effect.result(work))) ? "accepted" : "refused";
}

function task(id: string): TaskRecord {
  const created = createInteractiveTask({
    id, owner, goalRef: `goal-${id}`, now: 1_000,
    authorization: { decisionId: `decision-${id}`, policyRevision: "1", decidedAt: "2026-01-01T00:00:00.000Z", state: "active", revokedAt: null },
    allowedCapabilities: ["read"], allowedOrigins: ["https://example.com"],
  });
  return { task: created, events: [] };
}

function cancelled(record: TaskRecord): TaskRecord {
  const next = transitionInteractiveTask(record.task as InteractiveTask, { owner, expectedRevision: record.task.revision, now: 2_000 }, { type: "cancel" });
  return { task: next.task, events: [...record.events, next.event] };
}

function dead(): number {
  deadPid ??= spawnSync(process.execPath, ["-e", ""]).pid;
  return deadPid;
}

function replaceLockFile(held: Device, pid: number): void {
  const staged = join(held.directory, "replacement.lock");
  writeFileSync(staged, JSON.stringify({ pid, owner: "replacement" }), { mode: 0o600 });
  renameSync(staged, held.lock);
}

function keySource(held: () => Device): TaskKeySource {
  return {
    take(scope) {
      const { evidence, key } = held();
      if (evidence.key === "KeyMissing") return storageKeySource(undefined).take(scope);
      const text = evidence.key === "KeyOk" ? key : randomBytes(16).toString("base64");
      return storageKeySource(Redacted.make(text)).take(scope);
    },
  };
}

function database(armed: Armed, held: () => Device): TaskDatabaseOpener {
  const trip = () => {
    if (armed.steal) {
      armed.steal = false;
      replaceLockFile(held(), dead());
    }
    if (armed.fail) {
      armed.fail = false;
      throw new ElizaError("The disk refused the statement", { code: "TASK_STORAGE_UNAVAILABLE" });
    }
  };
  return (path) => {
    const db = openNodeTaskDatabase(path);
    return {
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          all: (...parameters) => (trip(), statement.all(...parameters)),
          run: (...parameters) => (trip(), statement.run(...parameters)),
        };
      },
    };
  };
}

async function fresh(): Promise<Device> {
  const scratch = await scratchDirectory("task-store-driver");
  const directory = scratch.file("tasks");
  mkdirSync(directory, { mode: 0o700 });
  const decodes = new Map<string, boolean>();
  const armed: Armed = { fail: false, steal: false };
  const decode = (text: string): TaskRecord => {
    const record = decodeTaskRecord(text);
    if (decodes.get(record.task.id) === false) throw new ElizaError("Task schema 2 is not known to this build", { code: "TASK_INVALID" });
    return record;
  };
  const current = () => device!;
  const store = await run(createTaskStore({ directory, keys: keySource(current), decode, database: database(armed, current) }));
  const file = join(directory, "tasks.sqlite");
  return { scratch, directory, file, lock: `${file}.lock`, key: randomBytes(32).toString("base64"), decodes, armed, store, evidence: goodCustody, probes: 0 };
}

const holding = async (held: Device) => (await run(held.store.storageStatus())) === "ok";

async function open(held: Device, account: string, evidence: OpenEvidence): Promise<Outcome> {
  if (await holding(held)) return "refused";
  held.evidence = evidence;
  rmSync(held.lock, { force: true });
  if (!evidence.exclusiveLock) replaceLockFile(held, process.pid);
  if (!evidence.privatePath) chmodSync(held.directory, 0o755);
  try {
    await attempt(held.store.open(account));
  } finally {
    chmodSync(held.directory, 0o700);
    held.evidence = goodCustody;
  }
  return "accepted";
}

function diskRows(held: Device) {
  if (!existsSync(held.file)) return [];
  const { db, rows } = openTaskRows(openNodeTaskDatabase, held.file);
  db.close();
  return rows;
}

function copyIn(held: Device, taskId: string, account: string, purpose: Purpose, unfinished: boolean): void {
  const created = !existsSync(held.file);
  const { db } = openTaskRows(openNodeTaskDatabase, held.file);
  try {
    if (created) chmodSync(held.file, 0o600);
    const sealer = createTaskSealer(deriveTaskKeys(Buffer.from(held.key, "base64"), { account, namespace: "agent" }));
    const record = unfinished ? task(taskId) : cancelled(task(taskId));
    try {
      insertRecord(db, { id: taskId, revision: record.task.revision, unfinished, at: 1, payload: sealer.seal(JSON.stringify(record), purpose) });
    } finally {
      sealer.wipe();
    }
  } finally {
    db.close();
  }
}

async function readable(held: Device): Promise<{ readonly id: string; readonly record: TaskRecord } | undefined> {
  for (const { taskId } of (await run(held.store.custody())).records) {
    const read = await Effect.runPromise(Effect.result(held.store.get(taskId)));
    if (Result.isSuccess(read) && read.success !== null) return { id: taskId, record: read.success };
  }
  return undefined;
}

async function operate(held: Device, event: Extract<Event, { type: "operate" }>): Promise<Outcome> {
  if (!(await holding(held))) return "refused";
  const found = await readable(held);
  held.armed.fail = !event.succeeded;
  held.armed.steal = !event.ownerAfter;
  if (found !== undefined) {
    await attempt(event.writes ? held.store.save(found.record) : held.store.get(found.id));
    return "accepted";
  }
  if (event.writes && !event.succeeded) {
    held.probes += 1;
    await attempt(held.store.create(task(`operate-probe-${held.probes}`)));
    if (!held.armed.fail) return "accepted";
  }
  held.armed.fail = false;
  held.armed.steal = false;
  if (!event.ownerAfter) replaceLockFile(held, dead());
  await run(held.store.storageStatus());
  return "accepted";
}

async function scan(held: Device, taskId: string, decodes: boolean): Promise<Outcome> {
  if (!(await holding(held))) return "refused";
  const read = await Effect.runPromise(Effect.result(held.store.get(taskId)));
  if (Result.isSuccess(read) ? read.success === null : read.failure._tag !== "Unreadable") return "refused";
  const { account } = await run(held.store.custody());
  held.decodes.set(taskId, decodes);
  await run(held.store.close());
  return open(held, account, goodCustody);
}

async function endRecord(held: Device, taskId: string): Promise<Outcome> {
  const read = await Effect.runPromise(Effect.result(held.store.get(taskId)));
  if (Result.isFailure(read) || read.success === null || !holdsSlot(read.success)) return "refused";
  return attempt(held.store.save(cancelled(read.success)));
}

function createRecord(held: Device, taskId: string): Promise<Outcome> | Outcome {
  let record: TaskRecord;
  try {
    record = task(taskId);
  } catch (error) {
    if (error instanceof ElizaError) return "refused";
    throw error;
  }
  return attempt(held.store.create(record));
}

export const driver: Driver<Observed> & AsyncDisposable = {
  async reset() {
    await device?.scratch.remove();
    device = undefined;
    device = await fresh();
  },
  async dispatch(_key, event, by) {
    const held = device!;
    switch (event.type) {
      case "openStore": return open(held, event.account, event.evidence);
      case "replaceLock":
        replaceLockFile(held, dead());
        await run(held.store.storageStatus());
        return "accepted";
      case "closeStore":
        if ((await run(held.store.custody())).writer.tag !== "Opened") return "refused";
        await run(held.store.close());
        return "accepted";
      case "operate": return operate(held, event);
      case "foundRecord": {
        const taken = diskRows(held).some((row) => row.id === event.taskId);
        if ((await holding(held)) || taken || event.taskId === "" || event.account === "") return "refused";
        copyIn(held, event.taskId, event.account, event.purpose, event.unfinished);
        return "accepted";
      }
      case "scan": return scan(held, event.taskId, event.decodes);
      case "createRecord": return createRecord(held, event.taskId);
      case "endRecord": return endRecord(held, event.taskId);
      case "acknowledgeUnreadable": return attempt(held.store.acknowledgeUnreadable(String(by), event.taskId));
    }
  },
  async observe() {
    const held = device!;
    const ok = await holding(held);
    const state = await run(held.store.custody());
    const known = new Set(state.records.map((record) => record.taskId));
    const sealer = state.account === "" ? undefined : createTaskSealer(deriveTaskKeys(Buffer.from(held.key, "base64"), { account: state.account, namespace: "agent" }));
    const opens = (payload: string) => {
      try {
        sealer?.open(payload, "TaskRecord");
        return sealer !== undefined;
      } catch {
        return false;
      }
    };
    try {
      const pending = diskRows(held).filter((row) => !known.has(row.id))
        .map((row) => ({ taskId: row.id, authentic: opens(row.payload), unfinished: row.unfinished, hold: "Readable" }));
      const records = state.records.map((record) => ({
        taskId: record.taskId, authentic: record.seal.account === state.account && record.seal.purpose === "TaskRecord", unfinished: record.unfinished, hold: record.hold,
      }));
      return { account: state.account, writer: state.writer.tag, holdsLock: ok, records: [...records, ...pending].sort((a, b) => a.taskId.localeCompare(b.taskId)) };
    } finally {
      sealer?.wipe();
    }
  },
  async [Symbol.asyncDispose]() {
    await device?.scratch.remove();
    device = undefined;
  },
};

export const options: Options<Observed> = {
  keys: ["device"],
  view: (s) => ({
    account: s.account,
    writer: s.writer.tag,
    holdsLock: s.writer.tag === "Opened" && s.writer.generation === s.lockGeneration,
    records: s.records
      .map((record) => ({ taskId: record.taskId, authentic: record.seal.account === s.account && record.seal.purpose === "TaskRecord", unfinished: record.unfinished, hold: record.hold }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId)),
  }),
};
