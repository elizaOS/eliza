/**
 * Composes a lease-authorized synthetic controller over the real agent boot and
 * PGlite repository path. The journal durably grants one boot attempt; it does
 * not claim atomicity between SQLite journal state and the PGlite domain store.
 */

import path from "node:path";
import { ElizaError } from "@elizaos/core/errors";
import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";
import type { SqliteSyntheticCommandJournal } from "./sqlite-command-journal";
import {
  SYNTHETIC_WORLD_CAPABILITIES,
  SYNTHETIC_WORLD_COMMAND_VERSION,
} from "./types";

const BOOT_COMMAND_TYPE = "controller.production-boot.claim.v1";
const PRODUCTION_RUNTIME_MODULE = "@elizaos/agent/runtime";

/** Internal runtime shape used by the non-package-exported adversarial seam. */
export interface SyntheticProductionRuntime {
  agentId: string;
  adapter?: { constructor: { name: string } };
  character: { name?: string };
  plugins: Array<{ name: string }>;
  getEntityById(id: string): Promise<{ id?: string } | null>;
}

/** Internal test seam; deliberately omitted from the package barrel. */
export interface SyntheticProductionRuntimeModule {
  startEliza(options: {
    headless: true;
    onRuntimeCreated(runtime: SyntheticProductionRuntime): void;
    configOverride: {
      meta: { firstRunComplete: true };
      ui: { assistant: { name: string } };
      database: { provider: "pglite"; pglite: { dataDir: string } };
      logging: { level: "error" };
    };
  }): Promise<SyntheticProductionRuntime | undefined>;
  shutdownRuntime(
    runtime: SyntheticProductionRuntime,
    context: string,
    options: { fast: true },
  ): Promise<void>;
}

function isProductionRuntimeModule(
  value: unknown,
): value is SyntheticProductionRuntimeModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.startEliza === "function" &&
    typeof candidate.shutdownRuntime === "function"
  );
}

export interface ProductionSyntheticWorldBootInput {
  authority: SyntheticEnvironmentLeaseAuthority;
  journal: SqliteSyntheticCommandJournal;
  commandId: string;
  runtimeName: string;
  pgliteDataDir: string;
}

export interface ProductionSyntheticWorldRuntimeProof {
  agentId: string;
  agentEntityId: string;
  adapter: "PgliteDatabaseAdapter";
  runtimeName: string;
  pgliteDataDir: string;
  journalGeneration: number;
  runtimePluginNames: string[];
  productionConfig: {
    runtimeName: string;
    databaseProvider: "pglite";
    pgliteDataDir: string;
  };
}

export type ProductionSyntheticWorldFailureStage =
  | "input"
  | "claim"
  | "initialization"
  | "proof"
  | "teardown";

export interface ProductionSyntheticWorldFailure {
  code: string;
  message: string;
}

export type ProductionSyntheticWorldBootResult =
  | {
      status: "available";
      controller: ProductionSyntheticWorldController;
      proof: ProductionSyntheticWorldRuntimeProof;
      capabilities: typeof SYNTHETIC_WORLD_CAPABILITIES;
    }
  | {
      status: "unavailable";
      failure: ProductionSyntheticWorldFailure;
      capabilities: typeof SYNTHETIC_WORLD_CAPABILITIES;
    }
  | {
      status: "failed";
      stage: ProductionSyntheticWorldFailureStage;
      failure: ProductionSyntheticWorldFailure;
      capabilities: typeof SYNTHETIC_WORLD_CAPABILITIES;
    };

function controllerError(
  code: string,
  message: string,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, { code, severity: "fatal", cause });
}

function validateInput(input: ProductionSyntheticWorldBootInput): void {
  if (
    input.runtimeName.trim().length === 0 ||
    input.runtimeName !== input.runtimeName.trim() ||
    !path.isAbsolute(input.pgliteDataDir) ||
    input.pgliteDataDir.trim() !== input.pgliteDataDir
  ) {
    throw controllerError(
      "SYNTHETIC_CONTROLLER_INVALID_INPUT",
      "Runtime name must be trimmed and PGlite data directory must be an absolute path",
    );
  }
}

/** Owns the live production runtime and its idempotent teardown boundary. */
export interface ProductionSyntheticWorldController {
  readonly proof: ProductionSyntheticWorldRuntimeProof;
  stop(): Promise<void>;
}

class OwnedProductionSyntheticWorldController
  implements ProductionSyntheticWorldController
{
  private stopPromise: Promise<void> | null = null;

  constructor(
    runtime: SyntheticProductionRuntime,
    readonly proof: ProductionSyntheticWorldRuntimeProof,
    stopRuntime: (runtime: SyntheticProductionRuntime) => Promise<void>,
  ) {
    this.stopRuntime = () => stopRuntime(runtime);
  }

  private readonly stopRuntime: () => Promise<void>;

  async stop(): Promise<void> {
    this.stopPromise ??= this.stopRuntime().catch((error: unknown) => {
      // error-policy:J2 Teardown remains a typed visible failure on every idempotent caller.
      throw controllerError(
        "SYNTHETIC_CONTROLLER_TEARDOWN_FAILED",
        "Production synthetic controller teardown failed",
        error,
      );
    });
    await this.stopPromise;
  }
}

/**
 * Claims exactly one production boot attempt, boots the canonical agent
 * composition, and verifies the agent entity through its real SQL repository.
 */
export async function bootProductionSyntheticWorldController(
  input: ProductionSyntheticWorldBootInput,
): Promise<ProductionSyntheticWorldBootResult> {
  return bootWithProductionRuntime(input, async () => {
    const productionRuntime: unknown = await import(PRODUCTION_RUNTIME_MODULE);
    if (!isProductionRuntimeModule(productionRuntime)) {
      throw controllerError(
        "SYNTHETIC_CONTROLLER_RUNTIME_MODULE_INVALID",
        "The production agent runtime does not expose its boot and teardown contract",
      );
    }
    return productionRuntime;
  });
}

/** Internal adversarial seam; not exported from `@elizaos/synthetic-world`. */
export async function bootProductionSyntheticWorldControllerWithModule(
  input: ProductionSyntheticWorldBootInput,
  productionRuntime: SyntheticProductionRuntimeModule,
): Promise<ProductionSyntheticWorldBootResult> {
  return bootWithProductionRuntime(input, async () => productionRuntime);
}

async function bootWithProductionRuntime(
  input: ProductionSyntheticWorldBootInput,
  loadProductionRuntime: () => Promise<SyntheticProductionRuntimeModule>,
): Promise<ProductionSyntheticWorldBootResult> {
  let runtime: SyntheticProductionRuntime | undefined;
  let stopProductionRuntime:
    | ((runtime: SyntheticProductionRuntime, context: string) => Promise<void>)
    | undefined;
  let stage: ProductionSyntheticWorldFailureStage = "input";
  try {
    validateInput(input);
    stage = "claim";
    const claim = await input.journal.execute(
      input.authority,
      {
        version: SYNTHETIC_WORLD_COMMAND_VERSION,
        namespace: input.authority.namespace,
        generation: input.authority.generation,
        commandId: input.commandId,
        type: BOOT_COMMAND_TYPE,
        payload: {
          runtimeName: input.runtimeName,
          pgliteDataDir: input.pgliteDataDir,
        },
      },
      (database) => {
        database.run(`
          CREATE TABLE IF NOT EXISTS synthetic_world_controller_boot_claims (
            namespace TEXT NOT NULL,
            command_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            runtime_name TEXT NOT NULL,
            pglite_data_dir TEXT NOT NULL,
            PRIMARY KEY (namespace, command_id)
          )
        `);
        const inserted = database.run(
          `INSERT INTO synthetic_world_controller_boot_claims
           (namespace, command_id, generation, runtime_name, pglite_data_dir)
           VALUES (?, ?, ?, ?, ?)`,
          [
            input.authority.namespace,
            input.commandId,
            input.authority.generation,
            input.runtimeName,
            input.pgliteDataDir,
          ],
        );
        if (inserted.changes !== 1) {
          throw controllerError(
            "SYNTHETIC_CONTROLLER_CLAIM_NOT_DURABLE",
            "Controller boot claim did not insert exactly one row",
          );
        }
        return {
          generation: input.authority.generation,
          runtimeName: input.runtimeName,
        };
      },
    );
    if (claim.replayed) {
      throw controllerError(
        "SYNTHETIC_CONTROLLER_BOOT_ALREADY_CLAIMED",
        "The durable boot claim was already consumed; a new command ID is required",
      );
    }

    stage = "initialization";
    const productionRuntime = await loadProductionRuntime();
    const { shutdownRuntime, startEliza } = productionRuntime;
    const productionStop = (
      ownedRuntime: SyntheticProductionRuntime,
      context: string,
    ) => shutdownRuntime(ownedRuntime, context, { fast: true });
    stopProductionRuntime = productionStop;
    const bootedRuntime = await startEliza({
      headless: true,
      onRuntimeCreated(createdRuntime) {
        runtime = createdRuntime;
      },
      configOverride: {
        meta: { firstRunComplete: true },
        ui: { assistant: { name: input.runtimeName } },
        database: {
          provider: "pglite",
          pglite: { dataDir: input.pgliteDataDir },
        },
        logging: { level: "error" },
      },
    });
    if (!bootedRuntime) {
      if (runtime) {
        throw controllerError(
          "SYNTHETIC_CONTROLLER_INITIALIZATION_INCOMPLETE",
          "Production boot created a runtime but resolved without returning it",
        );
      }
      return {
        status: "unavailable",
        failure: {
          code: "SYNTHETIC_CONTROLLER_RUNTIME_UNAVAILABLE",
          message: "Production boot resolved without a local runtime",
        },
        capabilities: SYNTHETIC_WORLD_CAPABILITIES,
      };
    }
    runtime = bootedRuntime;
    stage = "proof";
    const adapter = runtime.adapter?.constructor.name;
    const runtimeName = runtime.character.name;
    const runtimePluginNames = runtime.plugins
      .map((plugin) => plugin.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const agentEntity = await runtime.getEntityById(runtime.agentId);
    if (
      adapter !== "PgliteDatabaseAdapter" ||
      agentEntity?.id !== runtime.agentId ||
      runtimeName !== input.runtimeName ||
      runtimePluginNames.some(
        (name) => name.length === 0 || name !== name.trim(),
      )
    ) {
      throw controllerError(
        "SYNTHETIC_CONTROLLER_REPOSITORY_PROOF_FAILED",
        "Production PGlite adapter and agent entity readback did not match",
      );
    }
    const proof: ProductionSyntheticWorldRuntimeProof = {
      agentId: runtime.agentId,
      agentEntityId: agentEntity.id,
      adapter,
      runtimeName,
      pgliteDataDir: input.pgliteDataDir,
      journalGeneration: input.authority.generation,
      runtimePluginNames,
      productionConfig: {
        runtimeName,
        databaseProvider: "pglite",
        pgliteDataDir: input.pgliteDataDir,
      },
    };
    return {
      status: "available",
      controller: new OwnedProductionSyntheticWorldController(
        runtime,
        proof,
        (ownedRuntime) =>
          productionStop(ownedRuntime, "synthetic production controller"),
      ),
      proof,
      capabilities: SYNTHETIC_WORLD_CAPABILITIES,
    };
  } catch (error) {
    let failure = error;
    if (
      stage === "claim" &&
      error instanceof ElizaError &&
      error.code === "SYNTHETIC_COMMAND_IN_PROGRESS"
    ) {
      failure = controllerError(
        "SYNTHETIC_CONTROLLER_BOOT_ALREADY_CLAIMED",
        "The durable boot claim is already owned by another execution",
        error,
      );
    }
    if (runtime && stopProductionRuntime) {
      try {
        await stopProductionRuntime(
          runtime,
          "failed synthetic production boot",
        );
      } catch (teardownError) {
        // error-policy:J2 Preserve teardown failure on the explicit failed result.
        failure = controllerError(
          "SYNTHETIC_CONTROLLER_BOOT_TEARDOWN_FAILED",
          "Production boot failed and its partial runtime could not be stopped",
          { bootError: error, teardownError },
        );
        stage = "teardown";
      }
    }
    // error-policy:J1 This factory is the controller boundary and returns an explicit staged failure.
    return {
      status: "failed",
      stage,
      failure: {
        code:
          failure instanceof ElizaError
            ? failure.code
            : "SYNTHETIC_CONTROLLER_BOOT_FAILED",
        message:
          failure instanceof Error
            ? failure.message
            : "Production runtime boot failed",
      },
      capabilities: SYNTHETIC_WORLD_CAPABILITIES,
    };
  }
}
