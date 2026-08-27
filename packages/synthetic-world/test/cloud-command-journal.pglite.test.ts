/**
 * Proves the storage-neutral command journal against real Cloud PGlite
 * transactions and the production agents repository without mocks.
 */

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { DbTransaction } from "@elizaos/cloud-shared/db/client";
import {
  closeDatabaseConnectionsForTests,
  dbWrite,
} from "@elizaos/cloud-shared/db/client";
import { agentsRepository } from "@elizaos/cloud-shared/db/repositories/agents/agents";
import { CloudSyntheticEnvironmentLeaseStore } from "@elizaos/cloud-shared/db/repositories/synthetic-environment-leases";
import { CloudSyntheticCommandJournalRepository } from "@elizaos/cloud-shared/db/repositories/synthetic-world-commands";
import { agentTable } from "@elizaos/cloud-shared/db/schemas/eliza";
import { syntheticEnvironmentLeases } from "@elizaos/cloud-shared/db/schemas/synthetic-environment-leases";
import { syntheticWorldCommands } from "@elizaos/cloud-shared/db/schemas/synthetic-world-commands";
import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";
import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";
import {
  LeaseFencedSyntheticCommandJournal,
  SYNTHETIC_WORLD_COMMAND_VERSION,
  type SyntheticCommandJournalRepository,
} from "../src";

const leaseStore = new CloudSyntheticEnvironmentLeaseStore();
const repository: SyntheticCommandJournalRepository<DbTransaction> =
  new CloudSyntheticCommandJournalRepository();
const journal = new LeaseFencedSyntheticCommandJournal(leaseStore, repository);

beforeAll(async () => {
  const { apply } = await pushSchema(
    { agentTable, syntheticEnvironmentLeases, syntheticWorldCommands } as never,
    dbWrite as never,
  );
  await apply();
}, 60_000);

beforeEach(async () => {
  await dbWrite.delete(syntheticWorldCommands);
  await dbWrite.delete(agentTable);
  await dbWrite.delete(syntheticEnvironmentLeases);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function acquire(
  namespace: string,
  leaseDurationMs = 5_000,
): Promise<SyntheticEnvironmentLeaseAuthority> {
  return (
    await leaseStore.acquire({
      namespace,
      owner: {
        ownerId: "cloud-journal-test",
        processId: process.pid,
        host: "pglite",
      },
      leaseDurationMs,
    })
  ).authority;
}

function command(
  authority: SyntheticEnvironmentLeaseAuthority,
  commandId: string,
  payload: null | Record<string, string> = null,
) {
  return {
    version: SYNTHETIC_WORLD_COMMAND_VERSION,
    namespace: authority.namespace,
    generation: authority.generation,
    commandId,
    type: "agent.ensure",
    payload,
  } as const;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) throw new Error("deferred resolver was not initialized");
  return { promise, resolve: resolvePromise };
}

describe("Cloud synthetic command journal on PGlite", () => {
  test("commits production agent readback with COMMITTED and replays without a second callback", async () => {
    const authority = await acquire("cloud:journal:exact");
    const agentId = "00000000-0000-4000-8000-000000000201";
    let callbackCount = 0;
    const committedReadbacks: Array<{ agentId: string; phase: string }> = [];

    const first = await journal.execute(
      authority,
      command(authority, "ensure-agent", { agentId }),
      async (tx) => {
        callbackCount += 1;
        await agentsRepository.ensure(
          { id: agentId, name: "Synthetic Cloud Agent" },
          tx,
        );
        const stored = await agentsRepository.findById(agentId, tx);
        if (!stored)
          throw new Error("agent readback missing inside transaction");
        return { agentId: stored.id, name: stored.name };
      },
      {
        async onCheckpoint(checkpoint) {
          if (checkpoint.phase !== "COMMITTED") return;
          const [agent] = await dbWrite
            .select({ id: agentTable.id })
            .from(agentTable)
            .where(eq(agentTable.id, agentId));
          const [record] = await dbWrite
            .select({ phase: syntheticWorldCommands.phase })
            .from(syntheticWorldCommands)
            .where(
              and(
                eq(syntheticWorldCommands.namespace, authority.namespace),
                eq(syntheticWorldCommands.command_id, "ensure-agent"),
              ),
            );
          if (agent && record)
            committedReadbacks.push({ agentId: agent.id, phase: record.phase });
        },
      },
    );
    expect(first).toMatchObject({
      replayed: false,
      result: { agentId, name: "Synthetic Cloud Agent" },
      record: { phase: "SUCCEEDED", outcome: "KNOWN_SUCCESS" },
    });
    expect(committedReadbacks).toEqual([{ agentId, phase: "COMMITTED" }]);

    const restartedJournal = new LeaseFencedSyntheticCommandJournal(
      new CloudSyntheticEnvironmentLeaseStore(),
      new CloudSyntheticCommandJournalRepository(),
    );
    const replay = await restartedJournal.execute(
      authority,
      command(authority, "ensure-agent", { agentId }),
      async () => {
        callbackCount += 1;
        throw new Error("replay callback must not run");
      },
    );
    expect(replay).toMatchObject({
      replayed: true,
      result: { agentId, name: "Synthetic Cloud Agent" },
    });
    expect(callbackCount).toBe(1);
    await expect(
      journal.execute(
        authority,
        command(authority, "ensure-agent", { agentId: "changed" }),
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_ID_CONFLICT" });
  });

  test("serializes a colliding caller and invokes the production mutation once", async () => {
    const authority = await acquire("cloud:journal:collision");
    const agentId = "00000000-0000-4000-8000-000000000205";
    let callbackCount = 0;
    const mutationReleased = deferred();
    const mutationEntered = deferred();
    const first = journal.execute(
      authority,
      command(authority, "colliding-agent", { agentId }),
      async (tx) => {
        callbackCount += 1;
        mutationEntered.resolve();
        await mutationReleased.promise;
        await agentsRepository.ensure(
          { id: agentId, name: "Colliding Agent" },
          tx,
        );
        return { agentId };
      },
    );
    await mutationEntered.promise;
    const second = journal.execute(
      authority,
      command(authority, "colliding-agent", { agentId }),
      async () => {
        callbackCount += 1;
        return { agentId };
      },
    );
    await Bun.sleep(20);
    mutationReleased.resolve();
    const collisionOutcome = await second.then(
      (execution) => ({ replayed: execution.replayed }),
      (error: unknown) => ({
        code:
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : null,
      }),
    );
    if ("code" in collisionOutcome) {
      expect(collisionOutcome.code).toBe("SYNTHETIC_COMMAND_IN_PROGRESS");
    } else {
      expect(collisionOutcome.replayed).toBe(true);
    }
    expect(await first).toMatchObject({ replayed: false, result: { agentId } });
    expect(callbackCount).toBe(1);
    expect(await agentsRepository.findById(agentId)).toMatchObject({
      id: agentId,
    });
  });

  test("rolls back the production row and COMMITTED transition when mutation fails", async () => {
    const authority = await acquire("cloud:journal:rollback");
    const agentId = "00000000-0000-4000-8000-000000000202";
    await expect(
      journal.execute(
        authority,
        command(authority, "rollback-agent"),
        async (tx) => {
          await agentsRepository.ensure(
            { id: agentId, name: "Must Roll Back" },
            tx,
          );
          throw new Error("reject exact transaction");
        },
      ),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_EXECUTION_FAILED" });
    expect(await agentsRepository.findById(agentId)).toBeNull();
    expect(await journal.inspect(authority, "rollback-agent")).toMatchObject({
      phase: "FAILED",
      outcome: "KNOWN_FAILURE",
      result: null,
    });
  });

  test("rejects stale authority and rolls back an expiry during mutation", async () => {
    const stale = await acquire("cloud:journal:stale");
    await leaseStore.rollover({ authority: stale, leaseDurationMs: 5_000 });
    await expect(
      journal.execute(stale, command(stale, "stale-command"), async () => null),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_LOST" });

    const expiring = await acquire("cloud:journal:expiry", 40);
    const agentId = "00000000-0000-4000-8000-000000000203";
    await expect(
      journal.execute(
        expiring,
        command(expiring, "expired-agent"),
        async (tx) => {
          await agentsRepository.ensure(
            { id: agentId, name: "Expired Agent" },
            tx,
          );
          await Bun.sleep(80);
          return { agentId };
        },
      ),
    ).rejects.toMatchObject({
      code: "SYNTHETIC_COMMAND_FAILURE_CLASSIFICATION_FAILED",
    });
    expect(await agentsRepository.findById(agentId)).toBeNull();
    expect(
      await dbWrite
        .select({
          phase: syntheticWorldCommands.phase,
          result: syntheticWorldCommands.result_json,
        })
        .from(syntheticWorldCommands)
        .where(eq(syntheticWorldCommands.command_id, "expired-agent")),
    ).toEqual([{ phase: "EXECUTING", result: null }]);
  });

  test("does not steal same-generation active execution during recovery", async () => {
    const authority = await acquire("cloud:journal:active");
    const recoveries: string[][] = [];
    await journal.execute(
      authority,
      command(authority, "active-command"),
      async () => null,
      {
        async onCheckpoint(checkpoint) {
          if (checkpoint.phase !== "EXECUTING") return;
          recoveries.push((await journal.recover(authority)).activeCommandIds);
        },
      },
    );
    expect(recoveries).toEqual([["active-command"]]);
  });

  test("classifies commit-before-response as DIRTY after generation recovery", async () => {
    const authority = await acquire("cloud:journal:ambiguous");
    const agentId = "00000000-0000-4000-8000-000000000204";
    await expect(
      journal.execute(
        authority,
        command(authority, "ambiguous-agent"),
        async (tx) => {
          await agentsRepository.ensure(
            { id: agentId, name: "Ambiguous Agent" },
            tx,
          );
          return { agentId };
        },
        {
          onCheckpoint(checkpoint) {
            if (checkpoint.phase === "COMMITTED")
              throw new Error("response channel lost");
          },
        },
      ),
    ).rejects.toThrow("response channel lost");
    expect(await agentsRepository.findById(agentId)).toMatchObject({
      id: agentId,
    });
    const next = await leaseStore.rollover({
      authority,
      leaseDurationMs: 5_000,
    });
    expect(await journal.recover(next.authority)).toEqual({
      retryableCommandIds: [],
      failedCommandIds: [],
      dirtyCommandIds: ["ambiguous-agent"],
      activeCommandIds: [],
    });
    expect(
      await journal.inspect(next.authority, "ambiguous-agent"),
    ).toMatchObject({
      phase: "DIRTY",
      outcome: "UNKNOWN",
    });
  });

  test("fails closed on corrupt JSON and a future-generation row", async () => {
    const authority = await acquire("cloud:journal:corrupt");
    await journal.execute(
      authority,
      command(authority, "corrupt-command"),
      async () => ({
        ok: "yes",
      }),
    );
    await dbWrite
      .update(syntheticWorldCommands)
      .set({ payload_json: "{" })
      .where(eq(syntheticWorldCommands.command_id, "corrupt-command"));
    await expect(
      journal.inspect(authority, "corrupt-command"),
    ).rejects.toMatchObject({
      code: "SYNTHETIC_COMMAND_STORAGE_FAILURE",
    });

    await journal.execute(
      authority,
      command(authority, "future-command"),
      async () => null,
    );
    await dbWrite
      .update(syntheticWorldCommands)
      .set({ generation: authority.generation + 1 })
      .where(eq(syntheticWorldCommands.command_id, "future-command"));
    await expect(
      journal.execute(
        authority,
        command(authority, "future-command"),
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_STORAGE_FAILURE" });
  });

  test("inspect and recover fail closed on a terminal row from a future generation", async () => {
    const authority = await acquire("cloud:journal:future-terminal");
    await journal.execute(
      authority,
      command(authority, "future-terminal-command"),
      async () => ({ ok: "yes" }),
    );
    await dbWrite
      .update(syntheticWorldCommands)
      .set({ generation: authority.generation + 1 })
      .where(eq(syntheticWorldCommands.command_id, "future-terminal-command"));

    await expect(
      journal.inspect(authority, "future-terminal-command"),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_STORAGE_FAILURE" });
    await expect(journal.recover(authority)).rejects.toMatchObject({
      code: "SYNTHETIC_COMMAND_STORAGE_FAILURE",
    });
  });
});
