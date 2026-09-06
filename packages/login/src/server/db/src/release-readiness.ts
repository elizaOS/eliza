/** Verifies the existing production identity schema without writing schema or migration records. */

import {
  inspectStewardSchemaMigrations,
  type StewardSchemaMigrationClient,
  type StewardSchemaMigrationInspection,
} from "./auth-schema-readiness";
import { createPostgresClient } from "./client";
import {
  inspectAppliedStewardCoreRepair,
  type StewardCoreRepairClient,
  type StewardCoreRepairInspection,
} from "./core-schema-readiness";

export type StewardReleaseSchema = "public" | "steward";

export type StewardReleaseReadinessClient = StewardCoreRepairClient &
  StewardSchemaMigrationClient;

export type InspectStewardReleaseReadinessOptions = {
  expectedSchema: StewardReleaseSchema;
  client?: StewardReleaseReadinessClient;
};

export type StewardReleaseReadinessInspection = {
  status: "ready";
  schema: StewardReleaseSchema;
  core: StewardCoreRepairInspection & { status: "already_applied" };
  authSchema: StewardSchemaMigrationInspection;
};

/**
 * Verify both independent production migration contracts. The core inspection
 * checks the exact live 0082-0110 catalog envelope and repair provenance; the
 * auth-schema inspection checks the separate 0111-0114 marker chain and its
 * physical RP-provenance postcondition. Neither check reads or writes Eliza's
 * shared drizzle.__drizzle_migrations ledger.
 */
export async function inspectStewardReleaseReadiness(
  options: InspectStewardReleaseReadinessOptions,
): Promise<StewardReleaseReadinessInspection> {
  const ownsClient = !options.client;
  const client =
    options.client ??
    (createPostgresClient() as unknown as StewardReleaseReadinessClient);
  try {
    const core = await inspectAppliedStewardCoreRepair({
      expectedSchema: options.expectedSchema,
      client,
    });
    const authSchema = await inspectStewardSchemaMigrations({
      client,
      expectedSchema: options.expectedSchema,
    });
    if (authSchema.schema !== options.expectedSchema) {
      throw new Error(
        "Steward release readiness inspections resolved different data schemas",
      );
    }
    return {
      status: "ready",
      schema: options.expectedSchema,
      core,
      authSchema,
    };
  } finally {
    if (ownsClient) {
      await client.end({ timeout: 5 });
    }
  }
}
