/** Exports the storage-neutral journal and production-derived controller composition. */

export { LeaseFencedSyntheticCommandJournal } from "./command-journal";
export type { SyntheticWorldControlAuthority } from "./control-authority.ts";
export { createSyntheticWorldControlAuthority } from "./control-authority.ts";
export type {
  SyntheticCommandJournalExpected,
  SyntheticCommandJournalIdentity,
  SyntheticCommandJournalMaybePromise,
  SyntheticCommandJournalPatch,
  SyntheticCommandJournalRepository,
  SyntheticCommandJournalRow,
} from "./journal-repository";
export type {
  ProductionSyntheticWorldBootInput,
  ProductionSyntheticWorldBootResult,
  ProductionSyntheticWorldController,
  ProductionSyntheticWorldFailure,
  ProductionSyntheticWorldFailureStage,
  ProductionSyntheticWorldRuntimeProof,
} from "./production-controller";
export { bootProductionSyntheticWorldController } from "./production-controller";
export type {
  SyntheticScenarioWorld,
  SyntheticScenarioWorldOptions,
  SyntheticSeedRequest,
} from "./scenario-world.ts";
export {
  parseSyntheticScenarioManifest,
  startSyntheticScenarioWorld,
} from "./scenario-world.ts";
export type {
  SyntheticCommandCheckpoint,
  SyntheticCommandExecution,
  SyntheticCommandExecutionOptions,
  SyntheticCommandHeartbeat,
  SyntheticCommandOutcome,
  SyntheticCommandPhase,
  SyntheticCommandRecord,
  SyntheticCommandRecovery,
  SyntheticJson,
  SyntheticWorldCommand,
} from "./types";
export {
  SYNTHETIC_WORLD_CAPABILITIES,
  SYNTHETIC_WORLD_COMMAND_VERSION,
} from "./types";
