// spec/os/update/operator.md, "Story: Update a device by cable"; spec/os/update/operator.md, "Story: Get back if the update fails"
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/os__update__operator.conformance.ts";
import type { Event, OperatorJournal } from "../../gen/os__update__operator.ts";
import { journalMachine, type JournalBinding } from "../../src/image/ota-operator.vibe";

const KEY = "journal";
const binding: JournalBinding = { serial: "DRIVER0001", otaSha256: "a".repeat(64), candidateRecordSha256: "b".repeat(64), installedRecordSha256: "c".repeat(64) };

let directory = mkdtempSync(path.join(os.tmpdir(), "eliza-os-operator-driver-"));
const journalFile = (key: string) => path.join(directory, `${key}.json`);
const machineFor = (key: string) => journalMachine(journalFile(key), binding);
const run = <A, E>(program: Effect.Effect<A, E, NodeServices.NodeServices>) => Effect.runPromise(Effect.provide(program, NodeServices.layer));
const outcome = <E>(sent: Effect.Effect<OperatorJournal, E>) =>
  sent.pipe(
    Effect.as("accepted" as const),
    Effect.catch((failure) => {
      const tag = (failure as { _tag?: string })._tag;
      return tag === "Rejected" || tag === "NotAnEvent" ? Effect.succeed("refused" as const) : Effect.fail(failure);
    }),
  );

export const driver: Driver & AsyncDisposable = {
  reset: () => {
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "eliza-os-operator-driver-"));
  },
  dispatch: (key, event: Event) => run(Effect.flatMap(machineFor(key), (journal) => outcome(journal.send(event)))),
  receive: (key, raw) => run(Effect.flatMap(machineFor(key), (journal) => outcome(journal.receive(raw)))),
  observe: (key) => run(Effect.flatMap(machineFor(key), (journal) => journal.get())),
  [Symbol.asyncDispose]: async () => rmSync(directory, { recursive: true, force: true }),
};

export const options: Options = { keys: [KEY] };
