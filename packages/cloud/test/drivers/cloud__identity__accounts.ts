// spec/cloud/identity/accounts.md, "Story: Get one account on first sign-in"; spec/cloud/identity/accounts.md, "Story: Attribute a referral without paying for it"
import type { Driver, Options } from "../../gen/cloud__identity__accounts.conformance.ts";
import type { Account, Event } from "../../gen/cloud__identity__accounts.ts";
import { readAccount, stepAccount } from "../../src/identity/accounts.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const emitted = new Map<string, unknown>();
const account = (key: string) => `account-${key}`;
const scoped = (key: string, organizationId: string) => `${key}/${organizationId}`;

async function dispatch(key: string, event: Event) {
  const sent = event.type === "openAccount" ? { ...event, organizationId: scoped(key, event.organizationId) } : event;
  if (sent.type === "openAccount") await cloud.sql("INSERT INTO organizations (id, name, created_at) VALUES ($1, $1, 0) ON CONFLICT (id) DO NOTHING", [sent.organizationId]);
  const done = await cloud.run(within((tx) => stepAccount(tx, account(key), sent, 0)));
  emitted.set(key, done.kind === "done" ? done.value.out : []);
  if (done.kind === "done") return "accepted" as const;
  if (done.tag === "Rejected") return "refused" as const;
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<Account> {
  const done = await cloud.run(within((tx) => readAccount(tx, account(key))));
  if (done.kind === "failed") throw new Error(`reading the account failed with ${done.tag}`, { cause: done.error });
  const prefix = scoped(key, "");
  const { organizationId } = done.value;
  return { ...done.value, organizationId: organizationId.startsWith(prefix) ? organizationId.slice(prefix.length) : organizationId };
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    emitted.clear();
    await cloud.reset([]);
  },
  dispatch,
  observe,
  observeOutput: (key) => emitted.get(key) ?? [],
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys: ["a", "b"] };
