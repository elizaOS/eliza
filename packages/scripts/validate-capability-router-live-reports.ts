import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const LIVE_REPORT_SCHEMA_VERSION = 1;

const REQUIRED_SURFACES = [
  "action",
  "provider",
  "route",
  "viewAsset",
  "model",
  "lifecycle",
  "event",
  "service",
  "appBridge",
  "evaluator",
  "responseHandlerEvaluator",
  "responseHandlerFieldEvaluator",
] as const;

const REQUIRED_REMOTE_MODULE_COUNT_FIELDS = [
  "actionCount",
  "providerCount",
  "evaluatorCount",
  "responseHandlerEvaluatorCount",
  "responseHandlerFieldEvaluatorCount",
  "routeCount",
  "modelCount",
  "eventCount",
  "serviceCount",
  "appCount",
  "appBridgeCount",
  "lifecycleCount",
  "widgetCount",
  "componentTypeCount",
  "viewCount",
] as const;

const REQUIRED_SURFACE_RPC_METHODS: Record<RequiredSurface, string[]> = {
  action: ["plugin.action.invoke"],
  provider: ["plugin.provider.get"],
  route: ["plugin.route.call"],
  viewAsset: ["plugin.asset.get"],
  model: ["plugin.model.invoke"],
  lifecycle: ["plugin.lifecycle.call"],
  event: ["plugin.event.handle"],
  service: ["plugin.service.call"],
  appBridge: ["plugin.appBridge.call"],
  evaluator: [
    "plugin.evaluator.shouldRun",
    "plugin.evaluator.prepare",
    "plugin.evaluator.prompt",
    "plugin.evaluator.process",
  ],
  responseHandlerEvaluator: [
    "plugin.responseHandlerEvaluator.shouldRun",
    "plugin.responseHandlerEvaluator.evaluate",
  ],
  responseHandlerFieldEvaluator: [
    "plugin.responseHandlerFieldEvaluator.shouldRun",
    "plugin.responseHandlerFieldEvaluator.parse",
    "plugin.responseHandlerFieldEvaluator.handle",
  ],
};

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

type RequiredSurface = (typeof REQUIRED_SURFACES)[number];
type RequiredRemoteModuleCountField =
  (typeof REQUIRED_REMOTE_MODULE_COUNT_FIELDS)[number];

type ValidationFailure = {
  file: string;
  message: string;
};

type ValidatedReport = {
  file: string;
  kind: "cloud" | "provider";
  endpointId: string;
  provider?: string;
  endpointUrlSha256?: string;
};

type ReportKind = ValidatedReport["kind"];

type RemoteModuleCountTotals = Record<RequiredRemoteModuleCountField, number>;
type RemoteSyncEvidence = {
  registeredPluginCount: number;
  registeredModuleKeys: Set<string>;
  registeredRemoteModuleCounts: RemoteModuleCountTotals;
};

type CliOptions = {
  expectedKind?: ReportKind;
  expectedCount?: {
    min: number;
    max: number;
  };
  maxAgeMs?: number;
  maxFutureMs?: number;
  allowedProviders: string[];
  requireCi: boolean;
  requireFileIdentity: boolean;
  matchGithubEnv: boolean;
  requiredProviders: string[];
  paths: string[];
};

const SENSITIVE_KEY_PATTERN =
  /(^|_)(api[_-]?key|auth[_-]?token|authorization|bearer|capability[_-]?router[_-]?token|password|secret|token)(_|$)/i;
const SENSITIVE_STRING_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:api[_-]?key|auth[_-]?token|authorization|capability[_-]?router[_-]?token|password|secret|token)\s*[:=]\s*["']?[^"'\s,}]{8,}/i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
];

function main(): void {
  const options = parseCliOptions(process.argv.slice(2));
  const { paths } = options;
  if (paths.length === 0) {
    throw new Error(
      "Usage: bun packages/scripts/validate-capability-router-live-reports.ts [--kind cloud|provider] [--expect-count N|MIN..MAX] [--max-age-minutes N] [--max-future-minutes N] [--allowed-providers a,b] [--require-providers a,b] [--require-ci] [--require-file-identity] [--match-github-env] <report-file-or-dir...>",
    );
  }

  const files = paths.flatMap(expandReportPath);
  if (files.length === 0) {
    throw new Error("No capability-router live report files found.");
  }

  const failures: ValidationFailure[] = [];
  const reports: ValidatedReport[] = [];
  for (const file of files) {
    try {
      reports.push(validateReportFile(file, options));
    } catch (error) {
      failures.push({
        file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  failures.push(
    ...validateReportSet(
      reports,
      options.expectedCount,
      options.requiredProviders,
      options.allowedProviders,
    ),
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`${failure.file}: ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Validated ${files.length} capability-router live report${files.length === 1 ? "" : "s"}.`,
  );
}

function parseCliOptions(args: string[]): CliOptions {
  const paths: string[] = [];
  let expectedKind: ReportKind | undefined;
  let expectedCount: CliOptions["expectedCount"];
  let maxAgeMs: number | undefined;
  let maxFutureMs: number | undefined;
  let allowedProviders: string[] = [];
  let requireCi = false;
  let requireFileIdentity = false;
  let matchGithubEnv = false;
  let requiredProviders: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--kind") {
      const value = args[index + 1];
      if (value !== "cloud" && value !== "provider") {
        throw new Error("--kind must be either cloud or provider.");
      }
      expectedKind = value;
      index += 1;
      continue;
    }
    if (arg === "--max-age-minutes") {
      maxAgeMs = parseMaxAgeMinutes(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--expect-count") {
      expectedCount = parseExpectedCount(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--expect-count=")) {
      expectedCount = parseExpectedCount(arg.slice("--expect-count=".length));
      continue;
    }
    if (arg.startsWith("--max-age-minutes=")) {
      maxAgeMs = parseMaxAgeMinutes(arg.slice("--max-age-minutes=".length));
      continue;
    }
    if (arg === "--max-future-minutes") {
      maxFutureMs = parsePositiveMinutes(
        args[index + 1],
        "--max-future-minutes",
      );
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-future-minutes=")) {
      maxFutureMs = parsePositiveMinutes(
        arg.slice("--max-future-minutes=".length),
        "--max-future-minutes",
      );
      continue;
    }
    if (arg === "--require-providers") {
      requiredProviders = parseProviderList(
        args[index + 1],
        "--require-providers",
      );
      index += 1;
      continue;
    }
    if (arg.startsWith("--require-providers=")) {
      requiredProviders = parseProviderList(
        arg.slice("--require-providers=".length),
        "--require-providers",
      );
      continue;
    }
    if (arg === "--allowed-providers") {
      allowedProviders = parseProviderList(
        args[index + 1],
        "--allowed-providers",
      );
      index += 1;
      continue;
    }
    if (arg.startsWith("--allowed-providers=")) {
      allowedProviders = parseProviderList(
        arg.slice("--allowed-providers=".length),
        "--allowed-providers",
      );
      continue;
    }
    if (arg === "--require-ci") {
      requireCi = true;
      continue;
    }
    if (arg === "--require-file-identity") {
      requireFileIdentity = true;
      continue;
    }
    if (arg === "--match-github-env") {
      requireCi = true;
      matchGithubEnv = true;
      continue;
    }
    if (arg.startsWith("--kind=")) {
      const value = arg.slice("--kind=".length);
      if (value !== "cloud" && value !== "provider") {
        throw new Error("--kind must be either cloud or provider.");
      }
      expectedKind = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    paths.push(arg);
  }
  return {
    expectedKind,
    expectedCount,
    maxAgeMs,
    maxFutureMs,
    allowedProviders,
    requireCi,
    requireFileIdentity,
    matchGithubEnv,
    requiredProviders,
    paths,
  };
}

function parseExpectedCount(value: string | undefined): {
  min: number;
  max: number;
} {
  if (!value) {
    throw new Error("--expect-count must be an integer or range.");
  }
  const range = value.split("..");
  if (range.length === 1) {
    const count = parseNonNegativeInteger(range[0], "--expect-count");
    return { min: count, max: count };
  }
  if (range.length === 2) {
    const min = parseNonNegativeInteger(range[0], "--expect-count");
    const max = parseNonNegativeInteger(range[1], "--expect-count");
    if (min > max) {
      throw new Error("--expect-count range minimum must not exceed maximum.");
    }
    return { min, max };
  }
  throw new Error("--expect-count must be an integer or range.");
}

function parseNonNegativeInteger(value: string, option: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`${option} must be a non-negative integer.`);
  }
  return count;
}

function parseProviderList(
  value: string | undefined,
  option: string,
): string[] {
  const providers =
    value
      ?.split(",")
      .map((provider) => provider.trim())
      .filter(Boolean) ?? [];
  if (providers.length === 0) {
    throw new Error(`${option} must include at least one provider.`);
  }
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!/^[a-z0-9-]+$/.test(provider)) {
      throw new Error(
        `${option} entries must use lowercase letters, numbers, or hyphens.`,
      );
    }
    if (seen.has(provider)) {
      throw new Error(`${option} must not contain duplicates.`);
    }
    seen.add(provider);
  }
  return providers;
}

function parseMaxAgeMinutes(value: string | undefined): number {
  return parsePositiveMinutes(value, "--max-age-minutes");
}

function parsePositiveMinutes(
  value: string | undefined,
  option: string,
): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`${option} must be a positive number.`);
  }
  return minutes * 60_000;
}

function expandReportPath(path: string): string[] {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return readdirSync(path)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => join(path, entry))
      .sort();
  }
  return [path];
}

function validateReportFile(
  file: string,
  options: Pick<
    CliOptions,
    | "expectedKind"
    | "maxAgeMs"
    | "maxFutureMs"
    | "requireCi"
    | "requireFileIdentity"
    | "matchGithubEnv"
  >,
): ValidatedReport {
  const report = parseJson(readFileSync(file, "utf8"), file);
  assertNoSensitiveFields(report, file);
  const schemaVersion = requireNumber(report.schemaVersion, "schemaVersion");
  if (schemaVersion !== LIVE_REPORT_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${LIVE_REPORT_SCHEMA_VERSION}.`);
  }
  const kind = requireString(report.kind, "kind");
  if (kind !== "cloud" && kind !== "provider") {
    throw new Error('kind must be either "cloud" or "provider".');
  }
  if (options.expectedKind !== undefined && kind !== options.expectedKind) {
    throw new Error(
      `kind must be "${options.expectedKind}" for this artifact.`,
    );
  }
  const endpointId = requireEndpointId(report.endpointId, "endpointId");
  const observedAt = requireIsoTimestamp(report.observedAt, "observedAt");
  const observedAtDeltaMs = Date.now() - observedAt.getTime();
  if (options.maxAgeMs !== undefined && observedAtDeltaMs > options.maxAgeMs) {
    throw new Error("observedAt is older than --max-age-minutes.");
  }
  if (
    options.maxFutureMs !== undefined &&
    observedAtDeltaMs < -options.maxFutureMs
  ) {
    throw new Error("observedAt is newer than --max-future-minutes.");
  }
  if (options.requireCi) {
    validateCiEvidence(report.ci, options.matchGithubEnv);
  }
  if (kind === "cloud") {
    requireString(report.agentId, "agentId");
    requireHttpBaseUrl(report.cloudApiBase, "cloudApiBase");
  }
  const provider =
    kind === "provider"
      ? requireProviderName(report.provider, "provider")
      : undefined;
  const endpointUrlSha256 =
    kind === "provider"
      ? requireSha256(report.endpointUrlSha256, "endpointUrlSha256")
      : undefined;
  if (options.requireFileIdentity) {
    validateReportFileIdentity(file, kind, provider);
  }

  const conformance = requireObject(report.conformance, "conformance");
  const conformanceEndpointId = requireString(
    conformance.endpointId,
    "conformance.endpointId",
  );
  if (conformanceEndpointId !== endpointId) {
    throw new Error("conformance.endpointId must match endpointId.");
  }
  const moduleCount = requireNumber(
    conformance.moduleCount,
    "conformance.moduleCount",
  );
  if (moduleCount <= 0) {
    throw new Error("conformance.moduleCount must be greater than zero.");
  }
  const moduleIds = requireArray(
    conformance.moduleIds,
    "conformance.moduleIds",
  );
  if (moduleIds.length !== moduleCount) {
    throw new Error(
      "conformance.moduleIds length must match conformance.moduleCount.",
    );
  }
  const observedModuleIds = new Set<string>();
  for (const [index, moduleId] of moduleIds.entries()) {
    const id = requireRemotePluginModuleId(
      moduleId,
      `conformance.moduleIds[${index}]`,
    );
    if (observedModuleIds.has(id)) {
      throw new Error("conformance.moduleIds must not contain duplicates.");
    }
    observedModuleIds.add(id);
  }

  const availability = requireObject(
    conformance.availability,
    "conformance.availability",
  );
  if (availability.available !== true) {
    throw new Error("conformance.availability.available must be true.");
  }
  const capabilities = requireObject(
    availability.capabilities,
    "conformance.availability.capabilities",
  );
  if (capabilities.plugin !== true) {
    throw new Error(
      "conformance.availability.capabilities.plugin must be true.",
    );
  }

  const exercised = requireObject(
    conformance.exercised,
    "conformance.exercised",
  );
  const exercisedModuleIds = new Set<string>();
  const exercisedTargetsBySurface = new Map<RequiredSurface, string>();
  for (const surface of REQUIRED_SURFACES) {
    const target = requireString(
      exercised[surface],
      `conformance.exercised.${surface}`,
    );
    exercisedTargetsBySurface.set(surface, target);
    exercisedModuleIds.add(
      validateExercisedTargetModule(surface, target, observedModuleIds),
    );
  }
  const summarizedModuleExerciseTargets = new Set<string>();
  const moduleExerciseKeys = new Set<string>();
  for (const [index, value] of requireArray(
    conformance.moduleExercises,
    "conformance.moduleExercises",
  ).entries()) {
    const exercise = requireObject(
      value,
      `conformance.moduleExercises[${index}]`,
    );
    const surface = requireRequiredSurface(
      exercise.surface,
      `conformance.moduleExercises[${index}].surface`,
    );
    const moduleId = requireRemotePluginModuleId(
      exercise.moduleId,
      `conformance.moduleExercises[${index}].moduleId`,
    );
    const target = requireString(
      exercise.target,
      `conformance.moduleExercises[${index}].target`,
    );
    const targetModuleId = validateExercisedTargetModule(
      surface,
      target,
      observedModuleIds,
    );
    if (targetModuleId !== moduleId) {
      throw new Error(
        `conformance.moduleExercises[${index}].target must start with moduleId.`,
      );
    }
    const exerciseKey = `${surface}\0${moduleId}\0${target}`;
    if (moduleExerciseKeys.has(exerciseKey)) {
      throw new Error(
        "conformance.moduleExercises must not contain duplicates.",
      );
    }
    moduleExerciseKeys.add(exerciseKey);
    exercisedModuleIds.add(moduleId);
    if (target === exercisedTargetsBySurface.get(surface)) {
      summarizedModuleExerciseTargets.add(`${surface}\0${target}`);
    }
  }
  for (const [surface, target] of exercisedTargetsBySurface.entries()) {
    if (!summarizedModuleExerciseTargets.has(`${surface}\0${target}`)) {
      throw new Error(
        `conformance.moduleExercises must include conformance.exercised.${surface}.`,
      );
    }
  }
  validateRpcCalls(
    conformance.rpcCalls,
    moduleExerciseKeys,
    exercisedTargetsBySurface,
    observedModuleIds,
  );

  requireObject(conformance.actionResult, "conformance.actionResult");
  requireObject(conformance.providerResult, "conformance.providerResult");
  const routeResult = requireObject(
    conformance.routeResult,
    "conformance.routeResult",
  );
  const status = requireNumber(
    routeResult.status,
    "conformance.routeResult.status",
  );
  if (status < 200 || status > 299) {
    throw new Error(
      "conformance.routeResult.status must be a 2xx HTTP status.",
    );
  }
  const assetResult = requireObject(
    conformance.assetResult,
    "conformance.assetResult",
  );
  const assetPath = requireString(
    assetResult.path,
    "conformance.assetResult.path",
  );
  if (!/\.(?:js|mjs)$/i.test(assetPath)) {
    throw new Error("conformance.assetResult.path must be a JavaScript asset.");
  }
  const assetContentType = requireString(
    assetResult.contentType,
    "conformance.assetResult.contentType",
  );
  if (!/(?:java|ecma)script/i.test(assetContentType)) {
    throw new Error("conformance.assetResult.contentType must be JavaScript.");
  }
  const manifestContentType = optionalString(
    assetResult.manifestContentType,
    "conformance.assetResult.manifestContentType",
  );
  if (
    manifestContentType !== undefined &&
    manifestContentType !== assetContentType
  ) {
    throw new Error(
      "conformance.assetResult.manifestContentType must match conformance.assetResult.contentType.",
    );
  }
  const manifestIntegrity = optionalString(
    assetResult.manifestIntegrity,
    "conformance.assetResult.manifestIntegrity",
  );
  const assetIntegrity = optionalString(
    assetResult.integrity,
    "conformance.assetResult.integrity",
  );
  if (
    manifestIntegrity !== undefined &&
    manifestIntegrity !== assetIntegrity
  ) {
    throw new Error(
      "conformance.assetResult.manifestIntegrity must match conformance.assetResult.integrity.",
    );
  }
  const byteLength = requireNumber(
    assetResult.byteLength,
    "conformance.assetResult.byteLength",
  );
  if (byteLength <= 0) {
    throw new Error(
      "conformance.assetResult.byteLength must be greater than zero.",
    );
  }
  const assetSha256 = requireString(
    assetResult.sha256,
    "conformance.assetResult.sha256",
  );
  requirePattern(
    assetSha256,
    /^[0-9a-f]{64}$/i,
    "conformance.assetResult.sha256",
  );
  if (assetSha256.toLowerCase() === EMPTY_SHA256) {
    throw new Error(
      "conformance.assetResult.sha256 must not be the empty SHA-256 digest.",
    );
  }
  requireObject(conformance.modelResult, "conformance.modelResult");
  requireObject(conformance.lifecycleResult, "conformance.lifecycleResult");
  requireObject(conformance.eventResult, "conformance.eventResult");
  requireObject(conformance.serviceResult, "conformance.serviceResult");
  requireObject(conformance.appBridgeResult, "conformance.appBridgeResult");
  validateEvaluatorResult(conformance.evaluatorResult);
  validateResponseHandlerEvaluatorResult(
    conformance.responseHandlerEvaluatorResult,
  );
  validateResponseHandlerFieldEvaluatorResult(
    conformance.responseHandlerFieldEvaluatorResult,
  );
  const syncEvidence = validateSyncEvidence(
    report.sync,
    endpointId,
    observedModuleIds,
    exercisedModuleIds,
  );
  validateRuntimeEvidence(report.runtime, syncEvidence);
  return {
    file,
    kind,
    endpointId,
    ...(provider === undefined ? {} : { provider }),
    ...(endpointUrlSha256 === undefined ? {} : { endpointUrlSha256 }),
  };
}

function validateRpcCalls(
  value: unknown,
  moduleExerciseKeys: Set<string>,
  exercisedTargetsBySurface: Map<RequiredSurface, string>,
  observedModuleIds: Set<string>,
): void {
  const rpcCalls = requireArray(value, "conformance.rpcCalls");
  const rpcCallKeys = new Set<string>();
  for (const [index, value] of rpcCalls.entries()) {
    const call = requireObject(value, `conformance.rpcCalls[${index}]`);
    const surface = requireRequiredSurface(
      call.surface,
      `conformance.rpcCalls[${index}].surface`,
    );
    const method = requireString(
      call.method,
      `conformance.rpcCalls[${index}].method`,
    );
    if (!REQUIRED_SURFACE_RPC_METHODS[surface].includes(method)) {
      throw new Error(
        `conformance.rpcCalls[${index}].method must be valid for its surface.`,
      );
    }
    const moduleId = requireRemotePluginModuleId(
      call.moduleId,
      `conformance.rpcCalls[${index}].moduleId`,
    );
    const target = requireString(
      call.target,
      `conformance.rpcCalls[${index}].target`,
    );
    const targetModuleId = validateExercisedTargetModule(
      surface,
      target,
      observedModuleIds,
    );
    if (targetModuleId !== moduleId) {
      throw new Error(
        `conformance.rpcCalls[${index}].target must start with moduleId.`,
      );
    }
    const rpcCallKey = `${method}\0${surface}\0${moduleId}\0${target}`;
    if (rpcCallKeys.has(rpcCallKey)) {
      throw new Error("conformance.rpcCalls must not contain duplicates.");
    }
    rpcCallKeys.add(rpcCallKey);
    if (!moduleExerciseKeys.has(`${surface}\0${moduleId}\0${target}`)) {
      throw new Error(
        "conformance.rpcCalls entries must be present in conformance.moduleExercises.",
      );
    }
  }
  for (const moduleExerciseKey of moduleExerciseKeys) {
    const [surface] = moduleExerciseKey.split("\0") as [RequiredSurface];
    for (const method of REQUIRED_SURFACE_RPC_METHODS[surface]) {
      if (!rpcCallKeys.has(`${method}\0${moduleExerciseKey}`)) {
        throw new Error(
          "conformance.rpcCalls must include every required method for each conformance.moduleExercises entry.",
        );
      }
    }
  }
  for (const [surface, target] of exercisedTargetsBySurface.entries()) {
    const separatorIndex = target.indexOf(":");
    const moduleId = target.slice(0, separatorIndex);
    for (const method of REQUIRED_SURFACE_RPC_METHODS[surface]) {
      if (!rpcCallKeys.has(`${method}\0${surface}\0${moduleId}\0${target}`)) {
        throw new Error(
          `conformance.rpcCalls must include conformance.exercised.${surface}.`,
        );
      }
    }
  }
}

function validateReportFileIdentity(
  file: string,
  kind: ReportKind,
  provider: string | undefined,
): void {
  const stem = basename(file, extname(file));
  if (kind === "cloud") {
    if (stem !== "cloud") {
      throw new Error('cloud report filename must be "cloud.json".');
    }
    return;
  }
  if (!provider) {
    throw new Error("provider must be present for provider report filename.");
  }
  if (stem !== provider) {
    throw new Error("provider report filename must match provider.");
  }
}

function validateCiEvidence(value: unknown, matchGithubEnv: boolean): void {
  const ci = requireObject(value, "ci");
  const runId = requireString(ci.runId, "ci.runId");
  requirePattern(runId, /^\d+$/, "ci.runId");
  const runAttempt = requireString(ci.runAttempt, "ci.runAttempt");
  requirePattern(runAttempt, /^\d+$/, "ci.runAttempt");
  const workflow = requireString(ci.workflow, "ci.workflow");
  const eventName = requireString(ci.eventName, "ci.eventName");
  if (eventName !== "workflow_dispatch" && eventName !== "schedule") {
    throw new Error("ci.eventName must be workflow_dispatch or schedule.");
  }
  const repository = requireString(ci.repository, "ci.repository");
  requirePattern(repository, /^[^/\s]+\/[^/\s]+$/, "ci.repository");
  const sha = requireString(ci.sha, "ci.sha");
  requirePattern(sha, /^[0-9a-f]{40}$/i, "ci.sha");
  const ref = requireString(ci.ref, "ci.ref");
  requirePattern(ref, /^refs\/[^\s]+$/, "ci.ref");
  if (!matchGithubEnv) return;
  assertMatchesEnv(runId, "GITHUB_RUN_ID", "ci.runId");
  assertMatchesEnv(runAttempt, "GITHUB_RUN_ATTEMPT", "ci.runAttempt");
  assertMatchesEnv(workflow, "GITHUB_WORKFLOW", "ci.workflow");
  assertMatchesEnv(eventName, "GITHUB_EVENT_NAME", "ci.eventName");
  assertMatchesEnv(repository, "GITHUB_REPOSITORY", "ci.repository");
  assertMatchesEnv(sha, "GITHUB_SHA", "ci.sha");
  assertMatchesEnv(ref, "GITHUB_REF", "ci.ref");
}

function requirePattern(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) {
    throw new Error(`${field} has invalid format.`);
  }
}

function assertMatchesEnv(value: string, envName: string, field: string): void {
  const expected = process.env[envName]?.trim();
  if (!expected) {
    throw new Error(`${envName} must be set when --match-github-env is used.`);
  }
  if (value !== expected) {
    throw new Error(`${field} must match ${envName}.`);
  }
}

function validateReportSet(
  reports: ValidatedReport[],
  expectedCount: CliOptions["expectedCount"],
  requiredProviders: string[],
  allowedProviders: string[],
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  if (
    expectedCount &&
    (reports.length < expectedCount.min || reports.length > expectedCount.max)
  ) {
    failures.push({
      file: "<report-set>",
      message:
        expectedCount.min === expectedCount.max
          ? `expected ${expectedCount.min} report(s), got ${reports.length}.`
          : `expected ${expectedCount.min}..${expectedCount.max} report(s), got ${reports.length}.`,
    });
  }
  const endpointOwners = new Map<string, string>();
  const endpointUrlFingerprintOwners = new Map<string, string>();
  const providerOwners = new Map<string, string>();
  const allowedProviderSet =
    allowedProviders.length === 0 ? null : new Set(allowedProviders);
  let cloudReportFile: string | undefined;

  for (const report of reports) {
    const endpointOwner = endpointOwners.get(report.endpointId);
    if (endpointOwner) {
      failures.push({
        file: report.file,
        message: `endpointId duplicates ${endpointOwner}.`,
      });
    } else {
      endpointOwners.set(report.endpointId, report.file);
    }

    if (report.kind === "cloud") {
      if (cloudReportFile) {
        failures.push({
          file: report.file,
          message: `cloud report duplicates ${cloudReportFile}.`,
        });
      } else {
        cloudReportFile = report.file;
      }
      continue;
    }

    const provider = report.provider;
    if (!provider) continue;
    if (allowedProviderSet && !allowedProviderSet.has(provider)) {
      failures.push({
        file: report.file,
        message: `provider "${provider}" is not in --allowed-providers.`,
      });
    }
    const providerOwner = providerOwners.get(provider);
    if (providerOwner) {
      failures.push({
        file: report.file,
        message: `provider duplicates ${providerOwner}.`,
      });
    } else {
      providerOwners.set(provider, report.file);
    }
    const endpointUrlSha256 = report.endpointUrlSha256;
    if (endpointUrlSha256) {
      const fingerprintOwner =
        endpointUrlFingerprintOwners.get(endpointUrlSha256);
      if (fingerprintOwner) {
        failures.push({
          file: report.file,
          message: `endpointUrlSha256 duplicates ${fingerprintOwner}.`,
        });
      } else {
        endpointUrlFingerprintOwners.set(endpointUrlSha256, report.file);
      }
    }
  }
  for (const provider of requiredProviders) {
    if (!providerOwners.has(provider)) {
      failures.push({
        file: "<report-set>",
        message: `required provider "${provider}" was not observed.`,
      });
    }
  }

  return failures;
}

function validateExercisedTargetModule(
  surface: RequiredSurface,
  target: string,
  observedModuleIds: Set<string>,
): string {
  const separatorIndex = target.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === target.length - 1) {
    throw new Error(
      `conformance.exercised.${surface} must start with an observed module id followed by ":".`,
    );
  }
  const moduleId = target.slice(0, separatorIndex);
  if (!observedModuleIds.has(moduleId)) {
    throw new Error(
      `conformance.exercised.${surface} must start with an observed module id followed by ":".`,
    );
  }
  return moduleId;
}

function requireRequiredSurface(value: unknown, field: string): RequiredSurface {
  const surface = requireString(value, field);
  if (!REQUIRED_SURFACES.includes(surface as RequiredSurface)) {
    throw new Error(`${field} must be a required remote capability surface.`);
  }
  return surface as RequiredSurface;
}

function validateSyncEvidence(
  value: unknown,
  endpointId: string,
  observedModuleIds: Set<string>,
  exercisedModuleIds: Set<string>,
): RemoteSyncEvidence {
  const sync = requireObject(value, "sync");
  const registered = requireArray(sync.registered, "sync.registered");
  if (registered.length === 0) {
    throw new Error("sync.registered must include at least one plugin.");
  }
  const registeredPluginNames = new Set<string>();
  for (const [index, pluginName] of registered.entries()) {
    const registeredPluginName = requireString(
      pluginName,
      `sync.registered[${index}]`,
    );
    if (registeredPluginNames.has(registeredPluginName)) {
      throw new Error("sync.registered must not contain duplicates.");
    }
    registeredPluginNames.add(registeredPluginName);
  }
  const registeredModules = requireArray(
    sync.registeredModules,
    "sync.registeredModules",
  );
  if (registeredModules.length !== registered.length) {
    throw new Error(
      "sync.registeredModules length must match sync.registered length.",
    );
  }
  const registeredModuleKeys = new Set<string>();
  const registeredRemoteModuleCounts = Object.fromEntries(
    REQUIRED_REMOTE_MODULE_COUNT_FIELDS.map((field) => [field, 0]),
  ) as RemoteModuleCountTotals;
  const registeredModuleIds = new Set<string>();
  for (const [index, entry] of registeredModules.entries()) {
    const item = requireObject(entry, `sync.registeredModules[${index}]`);
    const pluginName = requireString(
      item.pluginName,
      `sync.registeredModules[${index}].pluginName`,
    );
    if (!registeredPluginNames.has(pluginName)) {
      throw new Error(
        "sync.registeredModules pluginName must be present in sync.registered.",
      );
    }
    const moduleId = requireRemotePluginModuleId(
      item.moduleId,
      `sync.registeredModules[${index}].moduleId`,
    );
    if (!observedModuleIds.has(moduleId)) {
      throw new Error(
        "sync.registeredModules moduleId must be present in conformance.moduleIds.",
      );
    }
    const moduleEndpointId = requireString(
      item.endpointId,
      `sync.registeredModules[${index}].endpointId`,
    );
    if (moduleEndpointId !== endpointId) {
      throw new Error(
        "sync.registeredModules endpointId must match report endpointId.",
      );
    }
    let moduleSurfaceCount = 0;
    for (const field of REQUIRED_REMOTE_MODULE_COUNT_FIELDS) {
      const count = requireNonNegativeInteger(
        item[field],
        `sync.registeredModules[${index}].${field}`,
      );
      moduleSurfaceCount += count;
      registeredRemoteModuleCounts[field] += count;
    }
    if (moduleSurfaceCount <= 0) {
      throw new Error(
        `sync.registeredModules[${index}] must materialize at least one remote plugin surface.`,
      );
    }
    registeredModuleIds.add(moduleId);
    const registeredModuleKey = `${moduleEndpointId}\0${moduleId}\0${pluginName}`;
    if (registeredModuleKeys.has(registeredModuleKey)) {
      throw new Error("sync.registeredModules must not contain duplicates.");
    }
    registeredModuleKeys.add(registeredModuleKey);
  }
  for (const [field, count] of Object.entries(registeredRemoteModuleCounts)) {
    if (count <= 0) {
      throw new Error(
        `sync.registeredModules aggregate ${field} must be greater than zero.`,
      );
    }
  }
  for (const moduleId of observedModuleIds) {
    if (!registeredModuleIds.has(moduleId)) {
      throw new Error(
        "every conformance.moduleIds entry must be present in sync.registeredModules.",
      );
    }
  }
  for (const moduleId of registeredModuleIds) {
    if (!exercisedModuleIds.has(moduleId)) {
      throw new Error(
        "every sync.registeredModules moduleId must be exercised by conformance.exercised.",
      );
    }
  }
  const unloadedPluginNames = validatePluginNameList(
    sync.unloaded,
    "sync.unloaded",
    {
      disallow: registeredPluginNames,
      disallowMessage:
        "sync.unloaded must not include plugins that are also registered.",
    },
  );
  const skippedPluginNames = validatePluginNameList(sync.skipped, "sync.skipped", {
    disallow: registeredPluginNames,
    disallowMessage:
      "sync.skipped must not include plugins that are also registered.",
    disallowAdditional: new Set(unloadedPluginNames),
    disallowAdditionalMessage:
      "sync.skipped must not include plugins that are also unloaded.",
  });
  const trustDecisions = requireArray(
    sync.trustDecisions,
    "sync.trustDecisions",
  );
  const trustedModuleIds = new Set<string>();
  const trustedModuleKeys = new Set<string>();
  const rejectedPluginNames = new Set<string>();
  for (const [index, decision] of trustDecisions.entries()) {
    const item = requireObject(decision, `sync.trustDecisions[${index}]`);
    if (item.endpointId !== undefined && item.endpointId !== endpointId) {
      continue;
    }
    if (item.trusted === false) {
      const pluginName = requireString(
        item.pluginName,
        `sync.trustDecisions[${index}].pluginName`,
      );
      rejectedPluginNames.add(pluginName);
      continue;
    }
    if (item.trusted === true && item.endpointId === endpointId) {
      const moduleId = requireRemotePluginModuleId(
        item.moduleId,
        `sync.trustDecisions[${index}].moduleId`,
      );
      const pluginName = requireString(
        item.pluginName,
        `sync.trustDecisions[${index}].pluginName`,
      );
      const trustedModuleKey = `${endpointId}\0${moduleId}\0${pluginName}`;
      if (trustedModuleKeys.has(trustedModuleKey)) {
        throw new Error("sync.trustDecisions must not contain duplicates.");
      }
      trustedModuleKeys.add(trustedModuleKey);
      trustedModuleIds.add(moduleId);
      if (!observedModuleIds.has(moduleId)) {
        throw new Error(
          "sync.trustDecisions trusted moduleId must be present in conformance.moduleIds.",
        );
      }
      if (!registeredModuleKeys.has(trustedModuleKey)) {
        throw new Error(
          "sync.trustDecisions trusted module must be present in sync.registeredModules.",
        );
      }
    }
  }
  for (const pluginName of skippedPluginNames) {
    if (!rejectedPluginNames.has(pluginName)) {
      throw new Error(
        "sync.skipped entries must have a rejected sync.trustDecisions entry.",
      );
    }
  }
  if (trustedModuleIds.size === 0) {
    throw new Error(
      "sync.trustDecisions must include at least one trusted module for endpointId.",
    );
  }
  for (const registeredModuleKey of registeredModuleKeys) {
    if (!trustedModuleKeys.has(registeredModuleKey)) {
      throw new Error(
        "every sync.registeredModules entry must have a trusted sync.trustDecisions entry.",
      );
    }
  }
  for (const moduleId of exercisedModuleIds) {
    if (!trustedModuleIds.has(moduleId)) {
      throw new Error(
        "conformance.exercised targets must belong to trusted registered modules.",
      );
    }
  }
  return {
    registeredPluginCount: registered.length,
    registeredModuleKeys,
    registeredRemoteModuleCounts,
  };
}

function validateRuntimeEvidence(
  value: unknown,
  syncEvidence: RemoteSyncEvidence,
): void {
  const runtime = requireObject(value, "runtime");
  const {
    registeredPluginCount,
    registeredModuleKeys,
    registeredRemoteModuleCounts,
  } = syncEvidence;
  validateRuntimeRemotePlugins(runtime.remotePlugins, registeredModuleKeys);
  requirePositiveCountAtLeast(
    runtime.pluginCount,
    "runtime.pluginCount",
    registeredPluginCount,
  );
  requirePositiveCountAtLeast(
    runtime.actionCount,
    "runtime.actionCount",
    registeredRemoteModuleCounts.actionCount,
  );
  requirePositiveCountAtLeast(
    runtime.providerCount,
    "runtime.providerCount",
    registeredRemoteModuleCounts.providerCount,
  );
  requirePositiveCountAtLeast(
    runtime.evaluatorCount,
    "runtime.evaluatorCount",
    registeredRemoteModuleCounts.evaluatorCount,
  );
  requirePositiveCountAtLeast(
    runtime.responseHandlerEvaluatorCount,
    "runtime.responseHandlerEvaluatorCount",
    registeredRemoteModuleCounts.responseHandlerEvaluatorCount,
  );
  requirePositiveCountAtLeast(
    runtime.responseHandlerFieldEvaluatorCount,
    "runtime.responseHandlerFieldEvaluatorCount",
    registeredRemoteModuleCounts.responseHandlerFieldEvaluatorCount,
  );
  requirePositiveCountAtLeast(
    runtime.routeCount,
    "runtime.routeCount",
    registeredRemoteModuleCounts.routeCount,
  );
  requirePositiveCountAtLeast(
    runtime.modelCount,
    "runtime.modelCount",
    registeredRemoteModuleCounts.modelCount,
  );
  requirePositiveCountAtLeast(
    runtime.eventCount,
    "runtime.eventCount",
    registeredRemoteModuleCounts.eventCount,
  );
  requirePositiveCountAtLeast(
    runtime.serviceCount,
    "runtime.serviceCount",
    registeredRemoteModuleCounts.serviceCount,
  );
  requirePositiveCountAtLeast(
    runtime.appCount,
    "runtime.appCount",
    registeredRemoteModuleCounts.appCount,
  );
  requirePositiveCountAtLeast(
    runtime.appBridgeCount,
    "runtime.appBridgeCount",
    registeredRemoteModuleCounts.appBridgeCount,
  );
  requirePositiveCountAtLeast(
    runtime.lifecycleCount,
    "runtime.lifecycleCount",
    registeredRemoteModuleCounts.lifecycleCount,
  );
  requirePositiveCountAtLeast(
    runtime.widgetCount,
    "runtime.widgetCount",
    registeredRemoteModuleCounts.widgetCount,
  );
  requirePositiveCountAtLeast(
    runtime.componentTypeCount,
    "runtime.componentTypeCount",
    registeredRemoteModuleCounts.componentTypeCount,
  );
  requirePositiveCountAtLeast(
    runtime.viewCount,
    "runtime.viewCount",
    registeredRemoteModuleCounts.viewCount,
  );
}

function validateRuntimeRemotePlugins(
  value: unknown,
  registeredModuleKeys: Set<string>,
): void {
  const remotePlugins = requireArray(value, "runtime.remotePlugins");
  const runtimeModuleKeys = new Set<string>();
  for (const [index, value] of remotePlugins.entries()) {
    const item = requireObject(value, `runtime.remotePlugins[${index}]`);
    const endpointId = requireString(
      item.endpointId,
      `runtime.remotePlugins[${index}].endpointId`,
    );
    const moduleId = requireRemotePluginModuleId(
      item.moduleId,
      `runtime.remotePlugins[${index}].moduleId`,
    );
    const pluginName = requireString(
      item.pluginName,
      `runtime.remotePlugins[${index}].pluginName`,
    );
    const runtimeModuleKey = `${endpointId}\0${moduleId}\0${pluginName}`;
    if (runtimeModuleKeys.has(runtimeModuleKey)) {
      throw new Error("runtime.remotePlugins must not contain duplicates.");
    }
    runtimeModuleKeys.add(runtimeModuleKey);
  }
  for (const registeredModuleKey of registeredModuleKeys) {
    if (!runtimeModuleKeys.has(registeredModuleKey)) {
      throw new Error(
        "runtime.remotePlugins must include every sync.registeredModules entry.",
      );
    }
  }
  for (const runtimeModuleKey of runtimeModuleKeys) {
    if (!registeredModuleKeys.has(runtimeModuleKey)) {
      throw new Error(
        "runtime.remotePlugins must not include entries absent from sync.registeredModules.",
      );
    }
  }
}

function validatePluginNameList(
  value: unknown,
  field: string,
  options: {
    disallow?: Set<string>;
    disallowMessage?: string;
    disallowAdditional?: Set<string>;
    disallowAdditionalMessage?: string;
  } = {},
): string[] {
  const values = requireArray(value, field).map((item, index) =>
    requireString(item, `${field}[${index}]`),
  );
  const seen = new Set<string>();
  for (const pluginName of values) {
    if (seen.has(pluginName)) {
      throw new Error(`${field} must not contain duplicates.`);
    }
    seen.add(pluginName);
    if (options.disallow?.has(pluginName)) {
      throw new Error(
        options.disallowMessage ??
          `${field} contains a disallowed plugin name.`,
      );
    }
    if (options.disallowAdditional?.has(pluginName)) {
      throw new Error(
        options.disallowAdditionalMessage ??
          `${field} contains a disallowed plugin name.`,
      );
    }
  }
  return values;
}

function assertNoSensitiveFields(value: unknown, path: string): void {
  if (typeof value === "string") {
    for (const pattern of SENSITIVE_STRING_PATTERNS) {
      if (pattern.test(value)) {
        throw new Error(
          `${path} must not contain credential-shaped string values in a live report artifact.`,
        );
      }
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSensitiveFields(item, `${path}[${index}]`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new Error(
        `${itemPath} must not be present in a live report artifact.`,
      );
    }
    assertNoSensitiveFields(item, itemPath);
  }
}

function validateEvaluatorResult(value: unknown): void {
  const result = requireObject(value, "conformance.evaluatorResult");
  const shouldRun = requireObject(
    result.shouldRun,
    "conformance.evaluatorResult.shouldRun",
  );
  if (typeof shouldRun.shouldRun !== "boolean") {
    throw new Error(
      "conformance.evaluatorResult.shouldRun.shouldRun must be boolean.",
    );
  }
  requireObject(result.prepare, "conformance.evaluatorResult.prepare");
  const prompt = requireObject(
    result.prompt,
    "conformance.evaluatorResult.prompt",
  );
  requireString(prompt.prompt, "conformance.evaluatorResult.prompt.prompt");
  requireObject(result.process, "conformance.evaluatorResult.process");
}

function validateResponseHandlerEvaluatorResult(value: unknown): void {
  const result = requireObject(
    value,
    "conformance.responseHandlerEvaluatorResult",
  );
  const shouldRun = requireObject(
    result.shouldRun,
    "conformance.responseHandlerEvaluatorResult.shouldRun",
  );
  if (typeof shouldRun.shouldRun !== "boolean") {
    throw new Error(
      "conformance.responseHandlerEvaluatorResult.shouldRun.shouldRun must be boolean.",
    );
  }
  requireObject(
    result.evaluate,
    "conformance.responseHandlerEvaluatorResult.evaluate",
  );
}

function validateResponseHandlerFieldEvaluatorResult(value: unknown): void {
  const result = requireObject(
    value,
    "conformance.responseHandlerFieldEvaluatorResult",
  );
  const shouldRun = requireObject(
    result.shouldRun,
    "conformance.responseHandlerFieldEvaluatorResult.shouldRun",
  );
  if (typeof shouldRun.shouldRun !== "boolean") {
    throw new Error(
      "conformance.responseHandlerFieldEvaluatorResult.shouldRun.shouldRun must be boolean.",
    );
  }
  requireObject(
    result.parse,
    "conformance.responseHandlerFieldEvaluatorResult.parse",
  );
  requireObject(
    result.handle,
    "conformance.responseHandlerFieldEvaluatorResult.handle",
  );
}

function parseJson(source: string, file: string): Record<string, unknown> {
  try {
    return requireObject(JSON.parse(source), file);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function requireEndpointId(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw new Error(
      `${field} must contain only letters, numbers, dots, underscores, colons, or hyphens.`,
    );
  }
  return text;
}

function requireRemotePluginModuleId(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new Error(
      `${field} must use letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return text;
}

function requireProviderName(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!/^[a-z0-9-]+$/.test(text)) {
    throw new Error(
      `${field} must use lowercase letters, numbers, or hyphens.`,
    );
  }
  return text;
}

function requireSha256(value: unknown, field: string): string {
  const text = requireString(value, field);
  requirePattern(text, /^[0-9a-f]{64}$/i, field);
  return text.toLowerCase();
}

function requireHttpBaseUrl(value: unknown, field: string): string {
  const text = requireString(value, field);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${field} must be an absolute http(s) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must be an absolute http(s) URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${field} must not include embedded credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${field} must not include query or fragment components.`);
  }
  return text;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

function requirePositiveCount(value: unknown, field: string): number {
  const count = requireNumber(value, field);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return count;
}

function requirePositiveCountAtLeast(
  value: unknown,
  field: string,
  minimum: number,
): number {
  const count = requirePositiveCount(value, field);
  if (count < minimum) {
    throw new Error(`${field} must be at least ${minimum}.`);
  }
  return count;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const count = requireNumber(value, field);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return count;
}

function requireIsoTimestamp(value: unknown, field: string): Date {
  const text = requireString(value, field);
  const timestamp = Date.parse(text);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== text
  ) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return new Date(timestamp);
}

main();
