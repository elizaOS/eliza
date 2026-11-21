// spec/cloud/identity/deletion.md, "Story: Delete an account once the person asked support"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/cloud__identity__deletion.conformance.ts";
import type { Deletion, Event } from "../../gen/cloud__identity__deletion.ts";
import { deletionRows, stepDeletion } from "../../src/identity/deletion.vibe";
import { loadRow } from "../../src/store/rows.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const keys = ["a", "b"];
const person = (key: string) => `deleted-${key}`;
const emitted = new Map<string, unknown>();

type ProviderKey = Deletion["receipt"]["providerKey"];

const providerIdPrefix = (key: string) => `${key}/`;

function logicalProviderKey(key: string, providerKey: ProviderKey): ProviderKey {
  if (providerKey.providerId === "") return providerKey;
  const prefix = providerIdPrefix(key);
  if (!providerKey.providerId.startsWith(prefix)) throw new Error("the stored provider key belongs to a different deletion");
  return { ...providerKey, providerId: providerKey.providerId.slice(prefix.length) };
}

async function dispatch(key: string, event: Event) {
  const stored = event.type === "prepareCall" && event.providerKey.providerId !== ""
    ? { ...event, providerKey: { ...event.providerKey, providerId: providerIdPrefix(key) + event.providerKey.providerId } }
    : event;
  const done = await cloud.run(within((tx) => Effect.flatMap(loadRow(tx, deletionRows, person(key)), (loaded) => stepDeletion(tx, person(key), stored, loaded.state.receipt.session.now))));
  emitted.set(key, done.kind === "done" ? done.value.out : []);
  if (done.kind === "done") return "accepted" as const;
  if (done.tag === "Rejected") return "refused" as const;
  throw new Error(`the deletion store failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<Deletion> {
  const done = await cloud.run(within((tx) => loadRow(tx, deletionRows, person(key), false)));
  if (done.kind === "failed") throw new Error(`reading the deletion failed with ${done.tag}`, { cause: done.error });
  const state = done.value.state;
  return {
    ...state,
    receipt: { ...state.receipt, providerKey: logicalProviderKey(key, state.receipt.providerKey) },
    usedKeys: state.usedKeys.map((providerKey) => logicalProviderKey(key, providerKey)),
  };
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    emitted.clear();
    await cloud.reset([]);
    await cloud.sql("DELETE FROM deletion_receipts");
    await cloud.sql("DELETE FROM deletion_requests");
  },
  dispatch,
  observe,
  observeOutput: (key) => emitted.get(key) ?? [],
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys };
