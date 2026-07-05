/** Public entry point for `@elizaos/scenario-runner`: re-exports the execution, discovery, reporting, and native-export surface. */
export * from "./cli";
export { runScenario } from "./executor.ts";
export { attachInterceptor } from "./interceptor.ts";
export { judgeTextWithLlm } from "./judge.ts";
export {
  countScenarioCorpus,
  discoverScenarios,
  expandScenarioDefinition,
  expandScenarioMetadata,
  listScenarioMetadata,
  loadAllScenarios,
  loadScenarioFile,
  loadScenarioMetadataFile,
  SCENARIO_EDGE_VARIANTS,
  validateScenarioCorpus,
} from "./loader.ts";
export type {
  NativeBoundaryRow,
  ScenarioNativeExportManifest,
} from "./native-export.ts";
export {
  exportScenarioNativeJsonl,
  recordedTrajectoryToNativeRows,
  SCENARIO_NATIVE_EXPORT_SCHEMA,
  SCENARIO_NATIVE_EXPORT_VERSION,
} from "./native-export.ts";
export {
  buildAggregate,
  printStdoutSummary,
  sumTrajectoryCostUsd,
  writeReport,
  writeScenarioRunViewer,
} from "./reporter.ts";
export type {
  AggregateReport,
  FinalCheckReport,
  ScenarioReport,
  TurnReport,
} from "./types.ts";
