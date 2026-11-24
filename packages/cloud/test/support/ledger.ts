// spec/cloud/shared/metering.md, "Story: Settle every call once"; spec/cloud/billing/funds.md, "Story: Spend only money the account has"
import { Cause, Clock, Effect, Exit, ManagedRuntime, Option } from "effect";
import type { Row, Tx } from "../../src/store/connection.vibe";
import { migrate, Store, storeLayer } from "../../src/store/store.vibe";
import { manualClock } from "./clock.ts";

export type Settled<A> = { readonly kind: "done"; readonly value: A } | { readonly kind: "failed"; readonly tag: string; readonly error: unknown };

export interface Ledger {
  at(milliseconds: number): void;
  run<A, E>(program: Effect.Effect<A, E, Store>): Promise<Settled<A>>;
  sql(text: string, params?: ReadonlyArray<unknown>): Promise<ReadonlyArray<Row>>;
  reset(organizations: ReadonlyArray<string>): Promise<void>;
  dispose(): Promise<void>;
}

export const within = <A, E>(body: (tx: Tx) => Effect.Effect<A, E>) => Effect.gen(function* () {
  const store = yield* Store;
  return yield* store.transaction(body);
});

export function ledger(): Ledger {
  const runtime = ManagedRuntime.make(storeLayer({ kind: "pglite", file: undefined }));
  const time = manualClock();
  let migrated: Promise<unknown> | undefined;
  const run = async <A, E>(program: Effect.Effect<A, E, Store>): Promise<Settled<A>> => {
    const exit = await runtime.runPromiseExit(Effect.provideService(program, Clock.Clock, time.clock));
    if (Exit.isSuccess(exit)) return { kind: "done", value: exit.value };
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (error === undefined) throw new Error(`the cloud died: ${Cause.pretty(exit.cause)}`);
    const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "unknown";
    return { kind: "failed", tag, error };
  };
  const sql = async (text: string, params: ReadonlyArray<unknown> = []) => {
    const done = await run(within((tx) => tx.query(text, params)));
    if (done.kind === "failed") throw new Error(`${text}: ${done.tag}`, { cause: done.error });
    return done.value;
  };
  return {
    at: (milliseconds) => time.set(milliseconds),
    run,
    sql,
    reset: async (organizations) => {
      migrated ??= run(migrate({ digest: "c".repeat(64), environment: "staging", now: 0 }));
      const report = await migrated;
      if ((report as Settled<unknown>).kind === "failed") throw new Error("the conformance database did not migrate", { cause: report });
      time.set(0);
      await sql("TRUNCATE organizations CASCADE");
      for (const id of organizations) await sql("INSERT INTO organizations (id, name, created_at) VALUES ($1, $1, 0)", [id]);
    },
    dispose: () => runtime.dispose(),
  };
}

export function identityDriverLedger() {
  const cloud = ledger();
  const emitted = new Map<string, unknown>();
  const person = (key: string) => `person-${key}`;
  const reset = async (organizations: ReadonlyArray<string>) => {
    emitted.clear();
    await cloud.reset(organizations);
  };

  return {
    ...cloud,
    person,
    reset,
    async resetPeople(keys: ReadonlyArray<string>) {
      await reset(keys.map((key) => `org-${key}`));
      for (const key of keys) {
        await cloud.sql("INSERT INTO accounts (key, state, revision, organization_id, status, created_at, updated_at) VALUES ($1, '{}'::jsonb, 1, $2, 'active', 0, 0)", [person(key), `org-${key}`]);
      }
    },
    async dispatch<A, E>(key: string, program: Effect.Effect<A, E, Store>, output: (value: A) => unknown): Promise<"accepted" | "refused"> {
      const done = await cloud.run(program);
      emitted.set(key, done.kind === "done" ? output(done.value) : []);
      if (done.kind === "done") return "accepted";
      if (done.tag === "Rejected") return "refused";
      throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
    },
    observeOutput: (key: string) => emitted.get(key) ?? [],
  };
}
