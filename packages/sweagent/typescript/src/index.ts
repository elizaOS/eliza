/**
 * Main exports TypeScript implementation
 */

import pkg from "../package.json";

export const __version__ = pkg.version;

export {
  AbstractActionSampler,
  ActionSamplerConfig,
  ActionSamplerOutput,
  AskColleagues,
  AskColleaguesConfig,
  BinaryTrajectoryComparison,
  BinaryTrajectoryComparisonConfig,
  createActionSampler,
} from "./agent/action-sampler";
// Agent module - selective exports to avoid conflicts
export {
  AbstractAgent,
  AgentConfig,
  DefaultAgent,
  DefaultAgentConfig,
  getAgentFromConfig,
  RetryAgent,
  RetryAgentConfig,
  ShellAgentConfig,
  TemplateConfig,
  ToolConfig as AgentToolConfig,
  ToolHandler as AgentToolHandler,
} from "./agent/agents";
export {
  AbstractHistoryProcessor,
  CacheControlHistoryProcessor,
  ClosedWindowHistoryProcessor,
  createHistoryProcessor,
  DefaultHistoryProcessor,
  ImageParsingHistoryProcessor,
  LastNObservations,
  RemoveRegex,
  TagToolCallObservations,
} from "./agent/history-processors";

export {
  AbstractModel,
  GenericAPIModelConfig,
  GlobalStats,
  getModel,
  HumanModel,
  HumanModelConfig,
  HumanThoughtModel,
  InstanceStats,
  InstantEmptySubmitModel,
  LiteLLMModel,
  ModelConfig,
  ModelOutput,
  ReplayModel,
  ReplayModelConfig,
} from "./agent/models";

export {
  EmptyProblemStatement,
  FileProblemStatement,
  GithubIssue,
  ProblemStatement,
  ProblemStatementConfig,
  problemStatementFromSimplifiedInput,
  SWEBenchMultimodalProblemStatement,
  TextProblemStatement,
} from "./agent/problem-statement";

export {
  AbstractRetryLoop,
  AbstractReviewer,
  Chooser,
  ChooserConfig,
  ChooserOutput,
  ChooserRetryLoop,
  ChooserRetryLoopConfig,
  getRetryLoopFromConfig,
  PreselectorConfig,
  PreselectorOutput,
  RetryLoopConfig,
  Reviewer,
  ReviewerConfig,
  ReviewerResult,
  ReviewSubmission,
  ScoreRetryLoop,
  ScoreRetryLoopConfig,
} from "./agent/reviewer";
export {
  AbstractDeployment,
  DeploymentConfig,
  DockerDeployment,
  DockerDeploymentConfig,
  getDeployment,
} from "./environment/deployment";
export {
  GithubRepo,
  GithubRepoConfig,
  LocalRepo,
  LocalRepoConfig,
  PreExistingRepo,
  PreExistingRepoConfig,
  Repo,
  RepoConfig,
  repoFromSimplifiedInput,
} from "./environment/repo";
export {
  AbstractRuntime,
  BashAction,
  BashActionResult,
  BashInterruptAction,
  Command,
  CommandResult,
  CreateBashSessionRequest,
  ReadFileRequest,
  ReadFileResponse,
  UploadRequest,
  WriteFileRequest,
} from "./environment/runtime";
// Environment module
export { EnvironmentConfig, SWEEnv } from "./environment/swe-env";
export * from "./exceptions";
export {
  AbstractInstanceSource,
  BatchInstance,
  BatchInstanceSourceConfig,
  createInstanceSource,
  filterBatchItems,
  InstancesFromFile,
  SimpleBatchInstance,
  SWEBenchInstances,
} from "./run/batch-instances";
export {
  createNestedDict,
  isPromisingPatch,
  parseArgsToNestedDict,
  savePredictions,
  shortenString,
  shortenStrings,
} from "./run/common";
export { SaveApplyPatchHook } from "./run/hooks/apply-patch";
export { OpenPRHook } from "./run/hooks/open-pr";
export { SweBenchEvaluate } from "./run/hooks/swe-bench-evaluate";
export { AbstractRunHook, CombinedRunHooks, RunHook } from "./run/hooks/types";
export { run } from "./run/run";
export { RunBatch, RunBatchConfig, runBatchFromConfig } from "./run/run-batch";
export {
  RunReplay,
  RunReplayConfig,
  runReplayFromConfig,
} from "./run/run-replay";
export { RunShell } from "./run/run-shell";
// Run module - selective exports
export {
  RunSingle,
  RunSingleActionConfig,
  RunSingleConfig,
  runFromConfig as runSingleFromConfig,
} from "./run/run-single";
// Tools module - selective exports
export { Bundle, BundleConfig } from "./tools/bundle";
export { Argument, Command as ToolCommand } from "./tools/commands";
export {
  AbstractParseFunction,
  ActionOnlyParser,
  ActionParser,
  createParser,
  FunctionCallingParser,
  IdentityParser,
  JsonParser,
  ParseFunction,
  ThoughtActionParser,
  XMLThoughtActionParser,
} from "./tools/parsing";
export {
  defaultToolConfig,
  defaultToolFilterConfig,
  ToolConfig,
  ToolFilterConfig,
  ToolHandler,
} from "./tools/tools";
export {
  generateCommandDocs,
  getSignature,
  guardMultilineInput,
  shouldQuote,
} from "./tools/utils";
// Core types
export * from "./types";
export {
  convertPathRelativeToRepoRoot,
  convertPathsToAbspath,
  convertPathToAbspath,
  couldBeAPath,
  loadEnvironmentVariables,
  stripAbspathFromDict,
} from "./utils/config";
export { loadFile } from "./utils/files";
export {
  getAssociatedCommitUrls,
  getGhIssueData,
  getProblemStatementFromGithubIssue,
  InvalidGithubURL,
  isGithubIssueUrl,
  isGithubRepoUrl,
  parseGhIssueUrl,
  parseGhRepoUrl,
} from "./utils/github";
export { warnProbablyWrongJinjaSyntax } from "./utils/jinja-warnings";
// Utils module - selective exports
export {
  AgentLogger,
  getLogger,
  getThreadName,
  log,
  setLogLevel,
  setThreadName,
} from "./utils/log";
export { PatchFormatter } from "./utils/patch-formatter";
export {
  convertToYamlLiteralString,
  mergeNestedDicts,
  yamlSerializationWithLinebreaks,
} from "./utils/serialization";

// Version info
export const VERSION = "1.1.0";

/**
 * Get agent commit hash
 */
export function getAgentCommitHash(): string {
  // In a real implementation, this would get the actual git commit hash
  return process.env.SWE_AGENT_COMMIT_HASH || "unknown";
}

/**
 * Get REX commit hash
 */
export function getRexCommitHash(): string {
  return process.env.SWE_REX_COMMIT_HASH || "unknown";
}

/**
 * Get REX version
 */
export function getRexVersion(): string {
  return process.env.SWE_REX_VERSION || "0.0.0";
}

/**
 * Get agent version info
 */
export function getAgentVersionInfo(): string {
  return `SWE-agent ${VERSION}`;
}
