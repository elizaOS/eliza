/**
 * Proves SW-1 against real file-backed SQLite stores, including subprocess
 * contention, process death, lease rollover, and durable restart recovery.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  SyntheticEnvironmentLeaseAuthority,
  SyntheticEnvironmentLeaseOwner,
} from "@elizaos/shared/contracts/synthetic-environment-lease";
import { SqliteSyntheticEnvironmentLeaseStore } from "../../cloud/test-mocks/src/synthetic-environment";
import {
  SqliteSyntheticCommandJournal,
  SYNTHETIC_WORLD_CAPABILITIES,
  SYNTHETIC_WORLD_COMMAND_VERSION,
  type SyntheticCommandRecovery,
  type SyntheticWorldCommand,
} from "../src";

const temporaryDirectories: string[] = [];
const workerPath = path.join(import.meta.dir, "fixtures", "command-worker.ts");

function tempDatabase(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "eliza-sw1-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "world.sqlite");
}

function owner(ownerId: string): SyntheticEnvironmentLeaseOwner {
  return { ownerId, processId: process.pid, host: "local-test" };
}

function command(
  authority: SyntheticEnvironmentLeaseAuthority,
  commandId: string,
  payload: SyntheticWorldCommand["payload"] = { value: "once" },
): SyntheticWorldCommand {
  return {
    version: SYNTHETIC_WORLD_COMMAND_VERSION,
    namespace: authority.namespace,
    generation: authority.generation,
    commandId,
    type: "test.write",
    payload,
  };
}

async function acquire(
  store: SqliteSyntheticEnvironmentLeaseStore,
  namespace: string,
  ownerId: string,
  leaseDurationMs: number,
): Promise<SyntheticEnvironmentLeaseAuthority> {
  return (
    await store.acquire({
      namespace,
      owner: owner(ownerId),
      leaseDurationMs,
    })
  ).authority;
}

async function runWorker(
  databasePath: string,
  authority: SyntheticEnvironmentLeaseAuthority,
  commandId: string,
  crashAt?: "OWNED" | "MUTATION" | "COMMITTED",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(
    [process.execPath, "--conditions=eliza-source", workerPath],
    {
      env: {
        ...process.env,
        SYNTHETIC_TEST_DATABASE_PATH: databasePath,
        SYNTHETIC_TEST_AUTHORITY: JSON.stringify(authority),
        SYNTHETIC_TEST_COMMAND_ID: commandId,
        SYNTHETIC_TEST_CRASH_AT: crashAt ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function rolloverAndRecover(
  databasePath: string,
  authority: SyntheticEnvironmentLeaseAuthority,
): Promise<{
  store: SqliteSyntheticEnvironmentLeaseStore;
  journal: SqliteSyntheticCommandJournal;
  authority: SyntheticEnvironmentLeaseAuthority;
}> {
  const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
  const nextAuthority = (
    await store.rollover({ authority, leaseDurationMs: 5_000 })
  ).authority;
  return {
    store,
    journal: new SqliteSyntheticCommandJournal(store),
    authority: nextAuthority,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteSyntheticCommandJournal", () => {
  test("reports the implemented incremental capabilities", () => {
    expect(SYNTHETIC_WORLD_CAPABILITIES.available).toEqual([
      "lease-generation-fence",
      "durable-command-journal",
      "production-runtime-boot",
      "production-pglite-readback",
    ]);
    expect(SYNTHETIC_WORLD_CAPABILITIES.unavailable).toContain(
      "cloud-command-journal-adapter",
    );
    expect(SYNTHETIC_WORLD_CAPABILITIES.unavailable).toContain(
      "observation-ledger",
    );
  });

  test("serializes two processes and mutates the domain exactly once", async () => {
    const databasePath = tempDatabase();
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(store, "collision", "coordinator", 5_000);
    store.close();

    const results = await Promise.all([
      runWorker(databasePath, authority, "same-command"),
      runWorker(databasePath, authority, "same-command"),
    ]);
    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    const outcomes = results.map(
      (result) =>
        JSON.parse(result.stdout) as {
          replayed?: boolean;
          errorCode?: string;
        },
    );
    expect(
      outcomes.filter((outcome) => outcome.replayed === false),
    ).toHaveLength(1);
    expect(
      outcomes.some(
        (outcome) =>
          outcome.replayed === true ||
          outcome.errorCode === "SYNTHETIC_COMMAND_IN_PROGRESS",
      ),
    ).toBe(true);
    const database = new Database(databasePath, {
      readonly: true,
      strict: true,
    });
    const count = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM synthetic_test_writes",
      )
      .get();
    expect(count?.count).toBe(1);
    database.close();
  });

  test("replays an exact result and rejects same-ID different-payload reuse", async () => {
    const databasePath = tempDatabase();
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(store, "replay", "owner", 5_000);
    const journal = new SqliteSyntheticCommandJournal(store);
    let mutations = 0;
    const mutate = () => {
      mutations += 1;
      return { mutation: mutations };
    };
    const first = await journal.execute(
      authority,
      command(authority, "stable", { b: 2, a: 1 }),
      mutate,
    );
    const replay = await journal.execute(
      authority,
      command(authority, "stable", { a: 1, b: 2 }),
      mutate,
    );
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, result: { mutation: 1 } });
    expect(mutations).toBe(1);
    await expect(
      journal.execute(
        authority,
        command(authority, "stable", { a: 2, b: 2 }),
        mutate,
      ),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_ID_CONFLICT" });
    store.close();
  });

  test("hashes keys by deterministic UTF-16 order and rejects non-JSON runtime values", async () => {
    const databasePath = tempDatabase();
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(store, "json", "owner", 5_000);
    const journal = new SqliteSyntheticCommandJournal(store);
    const execution = await journal.execute(
      authority,
      command(authority, "utf16", { ä: 2, z: 1 }),
      () => null,
    );
    expect(execution.record.payloadHash).toBe(
      createHash("sha256").update('{"z":1,"ä":2}').digest("hex"),
    );

    const sparse = new Array(1);
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        throw new Error("accessor must not execute");
      },
    });
    const nonEnumerable = { visible: true };
    Object.defineProperty(nonEnumerable, "hidden", { value: true });
    const symbolProperty = { visible: true };
    Object.defineProperty(symbolProperty, Symbol("hidden"), { value: true });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidValues: unknown[] = [
      { value: undefined },
      1n,
      () => null,
      Symbol("value"),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      sparse,
      Object.assign([], { custom: true }),
      new Date(),
      accessor,
      nonEnumerable,
      symbolProperty,
      cyclic,
    ];
    for (const [index, payload] of invalidValues.entries()) {
      await expect(
        journal.execute(
          authority,
          command(
            authority,
            `invalid-${index}`,
            payload as SyntheticWorldCommand["payload"],
          ),
          () => null,
        ),
      ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_INVALID_INPUT" });
    }
    await expect(
      journal.execute(
        authority,
        command(authority, "invalid-result"),
        () =>
          ({ value: undefined }) as unknown as SyntheticWorldCommand["payload"],
      ),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_INVALID_INPUT" });
    expect(await journal.inspect(authority, "invalid-result")).toMatchObject({
      phase: "FAILED",
      outcome: "KNOWN_FAILURE",
      error: { code: "SYNTHETIC_COMMAND_INVALID_INPUT" },
    });
    store.close();
  });

  test("heartbeats an owned command only with its execution token", async () => {
    const databasePath = tempDatabase();
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(store, "heartbeat", "owner", 5_000);
    const journal = new SqliteSyntheticCommandJournal(store);
    let heartbeatRevision = 0;
    await journal.execute(
      authority,
      command(authority, "heartbeat-command"),
      () => ({ ok: true }),
      {
        async onCheckpoint(checkpoint) {
          if (checkpoint.phase !== "OWNED") return;
          const record = await journal.heartbeat({
            authority,
            commandId: checkpoint.commandId,
            executionToken: checkpoint.executionToken,
          });
          heartbeatRevision = record.revision;
          await expect(
            journal.heartbeat({
              authority,
              commandId: checkpoint.commandId,
              executionToken: "wrong-token",
            }),
          ).rejects.toMatchObject({
            code: "SYNTHETIC_COMMAND_OWNERSHIP_LOST",
          });
        },
      },
    );
    expect(heartbeatRevision).toBe(2);
    store.close();
  });

  test("persists a typed error when a mutation fails", async () => {
    const databasePath = tempDatabase();
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(store, "error", "owner", 5_000);
    const journal = new SqliteSyntheticCommandJournal(store);
    let mutations = 0;
    const mutation = () => {
      mutations += 1;
      throw new Error("domain write failed");
    };
    await expect(
      journal.execute(authority, command(authority, "failure"), mutation),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_EXECUTION_FAILED" });
    await expect(
      journal.execute(authority, command(authority, "failure"), () => {
        throw new Error("domain write failed");
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_EXECUTION_FAILED" });
    expect(mutations).toBe(1);
    expect(await journal.inspect(authority, "failure")).toMatchObject({
      phase: "FAILED",
      outcome: "KNOWN_FAILURE",
      error: {
        code: "SYNTHETIC_COMMAND_EXECUTION_FAILED",
        message: "domain write failed",
      },
    });
    store.close();
  });

  test("translates corrupt stored payload and result JSON to storage failures", async () => {
    const databasePath = tempDatabase();
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(store, "corrupt", "owner", 5_000);
    const journal = new SqliteSyntheticCommandJournal(store);
    await journal.execute(authority, command(authority, "bad-payload"), () => ({
      ok: true,
    }));
    store.database.run(
      "UPDATE synthetic_world_commands SET payload_json = '{' WHERE namespace = ? AND command_id = ?",
      [authority.namespace, "bad-payload"],
    );
    await expect(
      journal.inspect(authority, "bad-payload"),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_STORAGE_FAILURE" });

    await journal.execute(authority, command(authority, "bad-result"), () => ({
      ok: true,
    }));
    store.database.run(
      "UPDATE synthetic_world_commands SET result_json = 'not-json' WHERE namespace = ? AND command_id = ?",
      [authority.namespace, "bad-result"],
    );
    await expect(
      journal.execute(authority, command(authority, "bad-result"), () => null),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_STORAGE_FAILURE" });
    store.close();
  });

  test("concurrent recovery leaves same-generation active ownership untouched", async () => {
    const databasePath = tempDatabase();
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(store, "active-recovery", "owner", 5_000);
    const journal = new SqliteSyntheticCommandJournal(store);
    const recoveries: SyntheticCommandRecovery[] = [];
    const execution = await journal.execute(
      authority,
      command(authority, "live-command"),
      () => ({ ok: true }),
      {
        async onCheckpoint(checkpoint) {
          if (checkpoint.phase === "EXECUTING") {
            recoveries.push(await journal.recover(authority));
          }
        },
      },
    );
    expect(recoveries).toEqual([
      {
        retryableCommandIds: [],
        failedCommandIds: [],
        dirtyCommandIds: [],
        activeCommandIds: ["live-command"],
      },
    ]);
    expect(execution.result).toEqual({ ok: true });
    store.close();
  });

  test("rejects stale and expired generations before command mutation", async () => {
    const databasePath = tempDatabase();
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const expired = await acquire(store, "fence", "old", 30);
    await Bun.sleep(60);
    let mutated = false;
    const journal = new SqliteSyntheticCommandJournal(store);
    await expect(
      journal.execute(expired, command(expired, "expired"), () => {
        mutated = true;
        return null;
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_LOST" });
    const current = await acquire(store, "fence", "new", 5_000);
    expect(current.generation).toBe(2);
    await expect(
      journal.execute(expired, command(expired, "stale"), () => null),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_LOST" });
    expect(mutated).toBe(false);
    store.close();
  });

  test("rejects a journal row from a generation newer than the active lease", async () => {
    const databasePath = tempDatabase();
    const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(store, "future-row", "owner", 5_000);
    const journal = new SqliteSyntheticCommandJournal(store);
    const input = command(authority, "future-command", { value: 1 });
    await journal.execute(authority, input, () => ({ accepted: true }));

    const database = new Database(databasePath, { strict: true });
    database.run(
      `UPDATE synthetic_world_commands
       SET generation = ?
       WHERE namespace = ? AND command_id = ?`,
      [authority.generation + 1, authority.namespace, input.commandId],
    );
    database.close();

    await expect(
      journal.execute(authority, input, () => ({ accepted: true })),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_STORAGE_FAILURE" });
    store.close();
  });

  test("recovers an OWNED crash as retryable and executes it after restart", async () => {
    const databasePath = tempDatabase();
    const initial = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(initial, "owned-crash", "old", 60_000);
    initial.close();
    const crashed = await runWorker(
      databasePath,
      authority,
      "owned-command",
      "OWNED",
    );
    expect(crashed.exitCode).not.toBe(0);
    expect(crashed.stderr).toBe("");
    const recovered = await rolloverAndRecover(databasePath, authority);
    const recovery = await recovered.journal.recover(recovered.authority);
    expect(recovery).toEqual({
      retryableCommandIds: ["owned-command"],
      failedCommandIds: [],
      dirtyCommandIds: [],
      activeCommandIds: [],
    });
    const execution = await recovered.journal.execute(
      recovered.authority,
      command(recovered.authority, "owned-command"),
      () => ({ recovered: true }),
    );
    expect(execution.result).toEqual({ recovered: true });
    recovered.store.close();
  });

  test("rolls back a mutation-process crash and recovers EXECUTING as known failure", async () => {
    const databasePath = tempDatabase();
    const initial = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(initial, "mutation-crash", "old", 60_000);
    initial.close();
    const crashed = await runWorker(
      databasePath,
      authority,
      "mutation-command",
      "MUTATION",
    );
    expect(crashed.exitCode).not.toBe(0);
    expect(crashed.stderr).toBe("");
    const recovered = await rolloverAndRecover(databasePath, authority);
    expect(await recovered.journal.recover(recovered.authority)).toEqual({
      retryableCommandIds: [],
      failedCommandIds: ["mutation-command"],
      dirtyCommandIds: [],
      activeCommandIds: [],
    });
    expect(
      await recovered.journal.inspect(recovered.authority, "mutation-command"),
    ).toMatchObject({
      phase: "FAILED",
      outcome: "KNOWN_FAILURE",
      error: { code: "SYNTHETIC_COMMAND_ABORTED_BEFORE_COMMIT" },
    });
    expect(() =>
      recovered.store.database
        .query("SELECT * FROM synthetic_test_writes")
        .all(),
    ).toThrow();
    await expect(
      recovered.journal.execute(
        recovered.authority,
        command(recovered.authority, "mutation-command"),
        () => ({ impossible: true }),
      ),
    ).rejects.toMatchObject({
      code: "SYNTHETIC_COMMAND_ABORTED_BEFORE_COMMIT",
    });
    recovered.store.close();
  });

  test("classifies commit-before-response as DIRTY/UNKNOWN after restart", async () => {
    const databasePath = tempDatabase();
    const initial = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
    const authority = await acquire(initial, "commit-crash", "old", 60_000);
    initial.close();
    const crashed = await runWorker(
      databasePath,
      authority,
      "committed-command",
      "COMMITTED",
    );
    expect(crashed.exitCode).not.toBe(0);
    expect(crashed.stderr).toBe("");
    const recovered = await rolloverAndRecover(databasePath, authority);
    expect(await recovered.journal.recover(recovered.authority)).toEqual({
      retryableCommandIds: [],
      failedCommandIds: [],
      dirtyCommandIds: ["committed-command"],
      activeCommandIds: [],
    });
    expect(
      await recovered.journal.inspect(recovered.authority, "committed-command"),
    ).toMatchObject({
      phase: "DIRTY",
      outcome: "UNKNOWN",
      error: { code: "SYNTHETIC_COMMAND_RECOVERED_AMBIGUOUS" },
    });
    const count = recovered.store.database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM synthetic_test_writes WHERE command_id = 'committed-command'",
      )
      .get();
    expect(count?.count).toBe(1);
    await expect(
      recovered.journal.execute(
        recovered.authority,
        command(recovered.authority, "committed-command"),
        () => ({ impossible: true }),
      ),
    ).rejects.toMatchObject({ code: "SYNTHETIC_COMMAND_DIRTY" });
    recovered.store.close();
  });
});
