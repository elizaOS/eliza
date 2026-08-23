/**
 * Boots the canonical production runtime against real PGlite and proves its
 * durable SQLite boot claim, production repository readback, fencing, replay,
 * explicit unavailable states, and idempotent teardown without simulators.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  SyntheticEnvironmentLeaseAuthority,
  SyntheticEnvironmentLeaseOwner,
} from "@elizaos/shared/contracts/synthetic-environment-lease";
import { SqliteSyntheticEnvironmentLeaseStore } from "../../cloud/test-mocks/src/synthetic-environment";
import {
  bootProductionSyntheticWorldController,
  SqliteSyntheticCommandJournal,
  SYNTHETIC_WORLD_COMMAND_VERSION,
} from "../src";
import {
  bootProductionSyntheticWorldControllerWithModule,
  type SyntheticProductionRuntime,
  type SyntheticProductionRuntimeModule,
} from "../src/production-controller";

const root = mkdtempSync(path.join(tmpdir(), "eliza-sw2-production-"));
const originalEnvironment = {
  ELIZA_AGENT_ORCHESTRATOR: process.env.ELIZA_AGENT_ORCHESTRATOR,
  ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS:
    process.env.ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
  ELIZA_PLUGIN_SET: process.env.ELIZA_PLUGIN_SET,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  LOG_LEVEL: process.env.LOG_LEVEL,
};

function owner(ownerId: string): SyntheticEnvironmentLeaseOwner {
  return { ownerId, processId: process.pid, host: "local-test" };
}

async function acquire(
  store: SqliteSyntheticEnvironmentLeaseStore,
  namespace: string,
  ownerId: string,
): Promise<SyntheticEnvironmentLeaseAuthority> {
  return (
    await store.acquire({
      namespace,
      owner: owner(ownerId),
      leaseDurationMs: 60_000,
    })
  ).authority;
}

function restoreEnvironment(): void {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

class PgliteDatabaseAdapter {}

function fakeRuntime(
  runtimeName: string,
  agentId = "00000000-0000-4000-8000-000000000001",
): SyntheticProductionRuntime {
  return {
    agentId,
    adapter: new PgliteDatabaseAdapter(),
    character: { name: runtimeName },
    plugins: [{ name: "z-last" }, { name: "a-first" }],
    async getEntityById(id) {
      return id === agentId ? { id: agentId } : null;
    },
  };
}

function fakeModule(options: {
  runtimeName: string;
  onStart?: () => void;
  teardownError?: Error;
}): SyntheticProductionRuntimeModule {
  return {
    async startEliza() {
      options.onStart?.();
      return fakeRuntime(options.runtimeName);
    },
    async shutdownRuntime() {
      if (options.teardownError) throw options.teardownError;
    },
  };
}

afterAll(() => {
  restoreEnvironment();
  rmSync(root, { recursive: true, force: true });
});

describe("production synthetic-world controller", () => {
  test("boots production PGlite once and rejects replay and stale authority before boot", async () => {
    process.env.ELIZA_PLUGIN_SET = "lean-chat";
    process.env.ELIZA_AGENT_ORCHESTRATOR = "0";
    process.env.ELIZA_STATE_DIR = path.join(root, "state");
    process.env.LOG_LEVEL = "fatal";

    const journalPath = path.join(root, "journal.sqlite");
    let store = new SqliteSyntheticEnvironmentLeaseStore(journalPath);
    let journal = new SqliteSyntheticCommandJournal(store);
    const authority = await acquire(store, "sw2-production", "first");
    const input = {
      authority,
      journal,
      commandId: "production-boot-1",
      runtimeName: "Synthetic Production",
      pgliteDataDir: path.join(root, "pglite"),
    };

    const booted = await bootProductionSyntheticWorldController(input);
    expect(booted.status).toBe("available");
    if (booted.status !== "available") throw new Error(booted.failure.message);
    expect(booted.proof).toMatchObject({
      adapter: "PgliteDatabaseAdapter",
      runtimeName: "Synthetic Production",
      journalGeneration: authority.generation,
      productionConfig: {
        runtimeName: "Synthetic Production",
        databaseProvider: "pglite",
        pgliteDataDir: input.pgliteDataDir,
      },
    });
    expect(booted.proof.runtimePluginNames.length).toBeGreaterThan(0);
    expect(booted.proof.runtimePluginNames).toEqual(
      [...booted.proof.runtimePluginNames].sort(),
    );
    expect(booted.proof.agentEntityId).toBe(booted.proof.agentId);
    expect(booted.capabilities.unavailable).toContain(
      "atomic-production-domain-command",
    );
    await booted.controller.stop();
    await booted.controller.stop();

    const restarted = await bootProductionSyntheticWorldController({
      ...input,
      commandId: "production-boot-2",
    });
    expect(restarted.status).toBe("available");
    if (restarted.status !== "available") {
      throw new Error(restarted.failure.message);
    }
    expect(restarted.proof.agentId).toBe(booted.proof.agentId);
    expect(restarted.proof.agentEntityId).toBe(booted.proof.agentEntityId);
    await restarted.controller.stop();

    store.close();
    store = new SqliteSyntheticEnvironmentLeaseStore(journalPath);
    journal = new SqliteSyntheticCommandJournal(store);
    const replay = await bootProductionSyntheticWorldController({
      ...input,
      journal,
    });
    expect(replay).toMatchObject({
      status: "failed",
      stage: "claim",
      failure: { code: "SYNTHETIC_CONTROLLER_BOOT_ALREADY_CLAIMED" },
    });

    await store.release(authority);
    await acquire(store, authority.namespace, "second");
    const stale = await bootProductionSyntheticWorldController({
      ...input,
      journal,
      commandId: "stale-boot",
    });
    expect(stale.status).toBe("failed");
    if (stale.status !== "failed") throw new Error("stale boot ran");
    expect(stale.stage).toBe("claim");
    expect(stale.failure.code).toBe("SYNTHETIC_LEASE_LOST");

    store.close();
  }, 180_000);

  test("rejects invalid public configuration without fabricating availability", async () => {
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "invalid.sqlite"),
    );
    const authority = await acquire(store, "sw2-invalid", "invalid");
    const result = await bootProductionSyntheticWorldController({
      authority,
      journal: new SqliteSyntheticCommandJournal(store),
      commandId: "invalid-boot",
      runtimeName: "Synthetic",
      pgliteDataDir: "relative/data",
    });
    expect(result).toMatchObject({
      status: "failed",
      stage: "input",
      failure: { code: "SYNTHETIC_CONTROLLER_INVALID_INPUT" },
    });
    store.close();
  }, 30_000);

  test("serializes concurrent duplicate boot claims to exactly one runtime boot", async () => {
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "concurrent.sqlite"),
    );
    const authority = await acquire(store, "sw2-concurrent", "concurrent");
    const journal = new SqliteSyntheticCommandJournal(store);
    let starts = 0;
    let notifyStarted!: () => void;
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let observedConfig: unknown;
    const module: SyntheticProductionRuntimeModule = {
      async startEliza(options) {
        starts += 1;
        observedConfig = options.configOverride;
        notifyStarted();
        await startGate;
        return fakeRuntime("Concurrent Synthetic");
      },
      async shutdownRuntime() {},
    };
    const input = {
      authority,
      journal,
      commandId: "concurrent-boot",
      runtimeName: "Concurrent Synthetic",
      pgliteDataDir: path.join(root, "concurrent-pglite"),
    };
    const first = bootProductionSyntheticWorldControllerWithModule(
      input,
      module,
    );
    const second = bootProductionSyntheticWorldControllerWithModule(
      input,
      module,
    );
    await started;
    releaseStart();
    const results = await Promise.all([first, second]);
    expect(starts).toBe(1);
    expect(
      results.filter((result) => result.status === "available"),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === "failed");
    expect(failure).toMatchObject({
      status: "failed",
      stage: "claim",
      failure: { code: "SYNTHETIC_CONTROLLER_BOOT_ALREADY_CLAIMED" },
    });
    expect(results.filter((result) => result.status === "failed")).toHaveLength(
      1,
    );
    const available = results.find((result) => result.status === "available");
    if (available?.status !== "available") throw new Error("boot missing");
    expect(available.proof.runtimePluginNames).toEqual(["a-first", "z-last"]);
    expect(observedConfig).toEqual({
      meta: { firstRunComplete: true },
      ui: { assistant: { name: "Concurrent Synthetic" } },
      database: {
        provider: "pglite",
        pglite: { dataDir: input.pgliteDataDir },
      },
      logging: { level: "error" },
    });
    await available.controller.stop();
    store.close();
  });

  test("journal mutation failure prevents runtime boot", async () => {
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "mutation-failure.sqlite"),
    );
    const authority = await acquire(
      store,
      "sw2-mutation-failure",
      "mutation-failure",
    );
    await store.withActiveGeneration(authority, (database) => {
      database.run(`
        CREATE TABLE synthetic_world_controller_boot_claims (
          namespace TEXT NOT NULL,
          command_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          runtime_name TEXT NOT NULL,
          pglite_data_dir TEXT NOT NULL,
          PRIMARY KEY (namespace, command_id)
        )
      `);
      database.run(
        `INSERT INTO synthetic_world_controller_boot_claims
         (namespace, command_id, generation, runtime_name, pglite_data_dir)
         VALUES (?, ?, ?, ?, ?)`,
        [
          authority.namespace,
          "mutation-failure-boot",
          authority.generation,
          "Existing",
          path.join(root, "existing"),
        ],
      );
    });
    let starts = 0;
    const result = await bootProductionSyntheticWorldControllerWithModule(
      {
        authority,
        journal: new SqliteSyntheticCommandJournal(store),
        commandId: "mutation-failure-boot",
        runtimeName: "Mutation Failure",
        pgliteDataDir: path.join(root, "mutation-failure-pglite"),
      },
      fakeModule({
        runtimeName: "Mutation Failure",
        onStart: () => {
          starts += 1;
        },
      }),
    );
    expect(starts).toBe(0);
    expect(result).toMatchObject({
      status: "failed",
      stage: "claim",
      failure: { code: "SYNTHETIC_COMMAND_EXECUTION_FAILED" },
    });
    store.close();
  });

  test("surfaces typed teardown failure idempotently", async () => {
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "teardown-failure.sqlite"),
    );
    const authority = await acquire(
      store,
      "sw2-teardown-failure",
      "teardown-failure",
    );
    const result = await bootProductionSyntheticWorldControllerWithModule(
      {
        authority,
        journal: new SqliteSyntheticCommandJournal(store),
        commandId: "teardown-failure-boot",
        runtimeName: "Teardown Failure",
        pgliteDataDir: path.join(root, "teardown-failure-pglite"),
      },
      fakeModule({
        runtimeName: "Teardown Failure",
        teardownError: new Error("stop rejected"),
      }),
    );
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error(result.failure.message);
    await expect(result.controller.stop()).rejects.toMatchObject({
      code: "SYNTHETIC_CONTROLLER_TEARDOWN_FAILED",
    });
    await expect(result.controller.stop()).rejects.toMatchObject({
      code: "SYNTHETIC_CONTROLLER_TEARDOWN_FAILED",
    });

    const failedBoot = await bootProductionSyntheticWorldControllerWithModule(
      {
        authority,
        journal: new SqliteSyntheticCommandJournal(store),
        commandId: "partial-teardown-failure-boot",
        runtimeName: "Partial Teardown Failure",
        pgliteDataDir: path.join(root, "partial-teardown-failure-pglite"),
      },
      {
        async startEliza() {
          return {
            ...fakeRuntime("Partial Teardown Failure"),
            async getEntityById() {
              return null;
            },
          };
        },
        async shutdownRuntime() {
          throw new Error("partial stop rejected");
        },
      },
    );
    expect(failedBoot).toMatchObject({
      status: "failed",
      stage: "teardown",
      failure: { code: "SYNTHETIC_CONTROLLER_BOOT_TEARDOWN_FAILED" },
    });
    store.close();
  });

  test("separates unavailable runtime from failed repository proof", async () => {
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "status-union.sqlite"),
    );
    const authority = await acquire(store, "sw2-status", "status");
    const journal = new SqliteSyntheticCommandJournal(store);
    const unavailable = await bootProductionSyntheticWorldControllerWithModule(
      {
        authority,
        journal,
        commandId: "unavailable-boot",
        runtimeName: "Unavailable Synthetic",
        pgliteDataDir: path.join(root, "unavailable-pglite"),
      },
      {
        async startEliza() {
          return undefined;
        },
        async shutdownRuntime() {},
      },
    );
    expect(unavailable).toMatchObject({
      status: "unavailable",
      failure: { code: "SYNTHETIC_CONTROLLER_RUNTIME_UNAVAILABLE" },
    });

    let callbackRuntimeStops = 0;
    const incomplete = await bootProductionSyntheticWorldControllerWithModule(
      {
        authority,
        journal,
        commandId: "callback-without-return-boot",
        runtimeName: "Incomplete Synthetic",
        pgliteDataDir: path.join(root, "incomplete-pglite"),
      },
      {
        async startEliza(options) {
          options.onRuntimeCreated(fakeRuntime("Incomplete Synthetic"));
          return undefined;
        },
        async shutdownRuntime() {
          callbackRuntimeStops += 1;
        },
      },
    );
    expect(incomplete).toMatchObject({
      status: "failed",
      stage: "initialization",
      failure: { code: "SYNTHETIC_CONTROLLER_INITIALIZATION_INCOMPLETE" },
    });
    expect(callbackRuntimeStops).toBe(1);

    const proofFailure = await bootProductionSyntheticWorldControllerWithModule(
      {
        authority,
        journal,
        commandId: "proof-failure-boot",
        runtimeName: "Proof Failure",
        pgliteDataDir: path.join(root, "proof-failure-pglite"),
      },
      {
        async startEliza() {
          return {
            ...fakeRuntime("Proof Failure"),
            plugins: [{ name: " invalid-plugin" }],
          };
        },
        async shutdownRuntime() {},
      },
    );
    expect(proofFailure).toMatchObject({
      status: "failed",
      stage: "proof",
      failure: { code: "SYNTHETIC_CONTROLLER_REPOSITORY_PROOF_FAILED" },
    });
    store.close();
  });

  test("does not steal same-generation active journal ownership", async () => {
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "active-ownership.sqlite"),
    );
    const authority = await acquire(store, "sw2-active", "active");
    const journal = new SqliteSyntheticCommandJournal(store);
    let releaseOwned!: () => void;
    let observedOwned!: () => void;
    const owned = new Promise<void>((resolve) => {
      observedOwned = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseOwned = resolve;
    });
    const activeExecution = journal.execute(
      authority,
      {
        version: SYNTHETIC_WORLD_COMMAND_VERSION,
        namespace: authority.namespace,
        generation: authority.generation,
        commandId: "active-neighbor",
        type: "test.active-neighbor",
        payload: { active: true },
      },
      () => ({ completed: true }),
      {
        onCheckpoint: async (checkpoint) => {
          if (checkpoint.phase === "OWNED") {
            observedOwned();
            await release;
          }
        },
      },
    );
    await owned;
    const boot = await bootProductionSyntheticWorldControllerWithModule(
      {
        authority,
        journal,
        commandId: "neighbor-boot",
        runtimeName: "Neighbor Synthetic",
        pgliteDataDir: path.join(root, "neighbor-pglite"),
      },
      fakeModule({ runtimeName: "Neighbor Synthetic" }),
    );
    expect((await journal.inspect(authority, "active-neighbor"))?.phase).toBe(
      "OWNED",
    );
    releaseOwned();
    await activeExecution;
    if (boot.status !== "available") throw new Error(boot.failure.message);
    await boot.controller.stop();
    store.close();
  });

  test("surfaces a real production boot rejection as initialization failure", async () => {
    process.env.ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS = "invalid";
    const store = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "failed-boot.sqlite"),
    );
    const authority = await acquire(store, "sw2-failed-boot", "failed-boot");
    const result = await bootProductionSyntheticWorldController({
      authority,
      journal: new SqliteSyntheticCommandJournal(store),
      commandId: "failed-production-boot",
      runtimeName: "Rejected Synthetic",
      pgliteDataDir: path.join(root, "rejected-pglite"),
    });
    expect(result).toMatchObject({
      status: "failed",
      stage: "initialization",
      failure: { code: "INVALID_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT" },
    });
    delete process.env.ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS;
    store.close();
  });
});
