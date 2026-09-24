/**
 * Recomputes and validates immutable trajectory and stage digests for one
 * freshly created, isolated run directory. It rejects aliasing, stale
 * artifacts, correlation mismatches, unfinished writes, and any filesystem
 * path that could escape or substitute content after the run.
 */

import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { ScenarioEvidenceTrajectoryHash } from "../types.ts";
import {
  type CanonicalJsonValue,
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";

export interface VerifiedTrajectoryStage {
  stageId: string;
  kind: string;
  sha256: string;
  startedAtIso: string;
  endedAtIso: string;
  tool?: {
    name: string;
    argsSha256: string;
    resultSha256: string;
    success: boolean;
  };
}

export interface VerifiedScenarioTrajectory {
  artifact: ScenarioEvidenceTrajectoryHash;
  stages: readonly [VerifiedTrajectoryStage, ...VerifiedTrajectoryStage[]];
}

export interface VerifiedScenarioTrajectorySet {
  runId: string;
  scenarioId: string;
  scenarioStartedAtIso: string;
  scenarioEndedAtIso: string;
  runDirectoryRealPath: string;
  verifiedAtIso: string;
  setSha256: string;
  trajectories: readonly [
    VerifiedScenarioTrajectory,
    ...VerifiedScenarioTrajectory[],
  ];
}

export interface VerifyScenarioTrajectoriesInput {
  runDir: string;
  runId: string;
  scenarioId: string;
  scenarioStartedAtIso: string;
  scenarioEndedAtIso: string;
  environment: string;
  expectedRelativePaths?: readonly string[];
  maxRunDirectoryAgeMs?: number;
  maxClockSkewMs?: number;
  now?: Date;
}

const DEFAULT_MAX_RUN_DIRECTORY_AGE_MS = 5 * 60_000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 5_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_VERIFIED_TRAJECTORIES = 1_024;
const MAX_STAGES_PER_TRAJECTORY = 65_536;

function fail(message: string): never {
  throw new Error(`provider-qualified trajectory verification ${message}`);
}

function requireString(value: unknown, pathLabel: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${pathLabel} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value: unknown, pathLabel: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(`${pathLabel} must be a non-negative epoch millisecond integer`);
  }
  return value;
}

function requireIso(value: string, pathLabel: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail(`${pathLabel} must be an ISO-8601 timestamp`);
  }
  return timestamp;
}

function asRecord(value: unknown, pathLabel: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${pathLabel} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function validateRelativePath(relativePath: string, pathLabel: string): string {
  requireString(relativePath, pathLabel);
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => segment === ".." || segment === "")
  ) {
    fail(
      `${pathLabel} contains traversal, an absolute path, or an empty segment`,
    );
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || !normalized.startsWith("trajectories/")) {
    fail(`${pathLabel} must be normalized beneath trajectories/`);
  }
  return normalized;
}

function requireExactKeys(
  value: Record<string, unknown>,
  pathLabel: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): void {
  const expected = new Set([...keys, ...optional]);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `${pathLabel} violates the closed verifier shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
}

function requireHash(value: unknown, pathLabel: string): string {
  const hash = requireString(value, pathLabel);
  if (!SHA256_PATTERN.test(hash)) {
    fail(`${pathLabel} must be a lowercase SHA-256 digest`);
  }
  return hash;
}

function requireCanonicalIso(
  value: unknown,
  pathLabel: string,
): {
  iso: string;
  timestamp: number;
} {
  const iso = requireString(value, pathLabel);
  const timestamp = requireIso(iso, pathLabel);
  if (new Date(timestamp).toISOString() !== iso) {
    fail(`${pathLabel} must use canonical UTC ISO-8601 form`);
  }
  return { iso, timestamp };
}

/**
 * Validate a trajectory set received after filesystem verification.
 *
 * Qualification may run in another process, so it recomputes the closed
 * verifier output shape and set digest instead of trusting a structural cast.
 */
export function validateVerifiedScenarioTrajectorySet(
  value: unknown,
): VerifiedScenarioTrajectorySet {
  const snapshot = canonicalJsonValue(
    value,
    "trajectories",
  ) as unknown as VerifiedScenarioTrajectorySet;
  const set = asRecord(snapshot, "trajectories");
  requireExactKeys(set, "trajectories", [
    "runId",
    "scenarioId",
    "scenarioStartedAtIso",
    "scenarioEndedAtIso",
    "runDirectoryRealPath",
    "verifiedAtIso",
    "setSha256",
    "trajectories",
  ]);
  requireString(set.runId, "trajectories.runId");
  requireString(set.scenarioId, "trajectories.scenarioId");
  const scenarioStartedAt = requireCanonicalIso(
    set.scenarioStartedAtIso,
    "trajectories.scenarioStartedAtIso",
  ).timestamp;
  const scenarioEndedAt = requireCanonicalIso(
    set.scenarioEndedAtIso,
    "trajectories.scenarioEndedAtIso",
  ).timestamp;
  requireCanonicalIso(set.verifiedAtIso, "trajectories.verifiedAtIso");
  if (scenarioEndedAt < scenarioStartedAt) {
    fail("trajectories scenario interval ends before it starts");
  }
  const runDirectoryRealPath = requireString(
    set.runDirectoryRealPath,
    "trajectories.runDirectoryRealPath",
  );
  if (
    !path.isAbsolute(runDirectoryRealPath) ||
    path.normalize(runDirectoryRealPath) !== runDirectoryRealPath
  ) {
    fail(
      "trajectories.runDirectoryRealPath must be a normalized absolute path",
    );
  }
  const claimedSetSha256 = requireHash(set.setSha256, "trajectories.setSha256");
  if (!Array.isArray(set.trajectories) || set.trajectories.length === 0) {
    fail("trajectories.trajectories must be non-empty");
  }
  if (set.trajectories.length > MAX_VERIFIED_TRAJECTORIES) {
    fail(
      `trajectories.trajectories cannot exceed ${MAX_VERIFIED_TRAJECTORIES} items`,
    );
  }

  const trajectoryIds = new Set<string>();
  const relativePaths = new Set<string>();
  let recorderEnvironment: string | undefined;
  let priorTrajectoryId: string | undefined;
  for (const [trajectoryIndex, rawTrajectory] of set.trajectories.entries()) {
    const trajectoryPath = `trajectories.trajectories[${trajectoryIndex}]`;
    const trajectory = asRecord(rawTrajectory, trajectoryPath);
    requireExactKeys(trajectory, trajectoryPath, ["artifact", "stages"]);
    const artifact = asRecord(
      trajectory.artifact,
      `${trajectoryPath}.artifact`,
    );
    requireExactKeys(artifact, `${trajectoryPath}.artifact`, [
      "trajectoryId",
      "relativePath",
      "sha256",
      "recorder",
    ]);
    const trajectoryId = requireString(
      artifact.trajectoryId,
      `${trajectoryPath}.artifact.trajectoryId`,
    );
    if (trajectoryIds.has(trajectoryId)) {
      fail(`${trajectoryPath}.artifact.trajectoryId is duplicated`);
    }
    if (
      priorTrajectoryId !== undefined &&
      priorTrajectoryId.localeCompare(trajectoryId) >= 0
    ) {
      fail("trajectories.trajectories must use verifier trajectoryId order");
    }
    trajectoryIds.add(trajectoryId);
    priorTrajectoryId = trajectoryId;
    const relativePath = validateRelativePath(
      requireString(
        artifact.relativePath,
        `${trajectoryPath}.artifact.relativePath`,
      ),
      `${trajectoryPath}.artifact.relativePath`,
    );
    if (path.posix.basename(relativePath) !== `${trajectoryId}.json`) {
      fail(
        `${trajectoryPath}.artifact.relativePath must end with the trajectoryId JSON filename`,
      );
    }
    if (relativePaths.has(relativePath)) {
      fail(`${trajectoryPath}.artifact.relativePath is duplicated`);
    }
    relativePaths.add(relativePath);
    requireHash(artifact.sha256, `${trajectoryPath}.artifact.sha256`);
    const recorder = asRecord(
      artifact.recorder,
      `${trajectoryPath}.artifact.recorder`,
    );
    requireExactKeys(recorder, `${trajectoryPath}.artifact.recorder`, [
      "implementation",
      "version",
      "environment",
    ]);
    if (
      recorder.implementation !== "@elizaos/core/trajectory-recorder" ||
      recorder.version !== "1"
    ) {
      fail(
        `${trajectoryPath}.artifact.recorder must identify the canonical trajectory recorder v1`,
      );
    }
    const environment = requireString(
      recorder.environment,
      `${trajectoryPath}.artifact.recorder.environment`,
    );
    recorderEnvironment ??= environment;
    if (recorderEnvironment !== environment) {
      fail("trajectories.trajectories must share one recorder environment");
    }

    if (!Array.isArray(trajectory.stages) || trajectory.stages.length === 0) {
      fail(`${trajectoryPath}.stages must be non-empty`);
    }
    if (trajectory.stages.length > MAX_STAGES_PER_TRAJECTORY) {
      fail(
        `${trajectoryPath}.stages cannot exceed ${MAX_STAGES_PER_TRAJECTORY} items`,
      );
    }
    const stageIds = new Set<string>();
    for (const [stageIndex, rawStage] of trajectory.stages.entries()) {
      const stagePath = `${trajectoryPath}.stages[${stageIndex}]`;
      const stage = asRecord(rawStage, stagePath);
      requireExactKeys(
        stage,
        stagePath,
        ["stageId", "kind", "sha256", "startedAtIso", "endedAtIso"],
        ["tool"],
      );
      const stageId = requireString(stage.stageId, `${stagePath}.stageId`);
      if (stageIds.has(stageId)) {
        fail(`${stagePath}.stageId is duplicated`);
      }
      stageIds.add(stageId);
      const kind = requireString(stage.kind, `${stagePath}.kind`);
      if (kind === "tool") {
        const tool = asRecord(stage.tool, `${stagePath}.tool`);
        requireExactKeys(tool, `${stagePath}.tool`, [
          "name",
          "argsSha256",
          "resultSha256",
          "success",
        ]);
        requireString(tool.name, `${stagePath}.tool.name`);
        requireHash(tool.argsSha256, `${stagePath}.tool.argsSha256`);
        requireHash(tool.resultSha256, `${stagePath}.tool.resultSha256`);
        if (typeof tool.success !== "boolean") {
          fail(`${stagePath}.tool.success must be a boolean`);
        }
      } else if (stage.tool !== undefined) {
        fail(`${stagePath}.tool is only valid for a tool stage`);
      }
      requireHash(stage.sha256, `${stagePath}.sha256`);
      const stageStartedAt = requireCanonicalIso(
        stage.startedAtIso,
        `${stagePath}.startedAtIso`,
      ).timestamp;
      const stageEndedAt = requireCanonicalIso(
        stage.endedAtIso,
        `${stagePath}.endedAtIso`,
      ).timestamp;
      if (
        stageStartedAt < scenarioStartedAt ||
        stageEndedAt > scenarioEndedAt ||
        stageEndedAt < stageStartedAt
      ) {
        fail(`${stagePath} falls outside the scenario interval`);
      }
    }
  }

  const recomputedSetSha256 = canonicalSha256(
    snapshot.trajectories.map((trajectory) => ({
      artifact: trajectory.artifact,
      stages: trajectory.stages,
    })),
    "verifiedTrajectories",
  );
  if (recomputedSetSha256 !== claimedSetSha256) {
    fail("trajectories.setSha256 does not match the verified trajectory set");
  }
  return snapshot;
}

function collectTrajectoryFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const metadata = lstatSync(target);
      if (metadata.isSymbolicLink()) {
        fail(`rejected symbolic link ${target}`);
      }
      if (metadata.isDirectory()) {
        visit(target);
        continue;
      }
      if (!metadata.isFile()) {
        fail(`rejected non-regular artifact ${target}`);
      }
      if (metadata.nlink !== 1) {
        fail(`rejected hard-linked artifact ${target}`);
      }
      if (!entry.name.endsWith(".json")) {
        fail(`rejected unexpected non-JSON artifact ${target}`);
      }
      files.push(target);
    }
  };
  visit(root);
  return files;
}

function stageCanonicalValue(
  stage: Record<string, unknown>,
  pathLabel: string,
): CanonicalJsonValue {
  return canonicalJsonValue(stage, pathLabel);
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readImmutableRegularFile(filePath: string): {
  bytes: Buffer;
  metadata: BigIntStats;
} {
  const beforePath = lstatSync(filePath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    fail(`rejected non-regular artifact ${filePath}`);
  }
  if (beforePath.nlink !== 1n) {
    fail(`rejected hard-linked artifact ${filePath}`);
  }
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const beforeRead = fstatSync(descriptor, { bigint: true });
    if (
      !beforeRead.isFile() ||
      beforeRead.nlink !== 1n ||
      beforeRead.dev !== beforePath.dev ||
      beforeRead.ino !== beforePath.ino
    ) {
      fail(`artifact identity changed before read ${filePath}`);
    }
    const bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(filePath, { bigint: true });
    if (
      !sameFileIdentity(beforeRead, afterRead) ||
      !sameFileIdentity(afterRead, afterPath)
    ) {
      fail(`artifact identity or contents changed during read ${filePath}`);
    }
    return { bytes, metadata: afterRead };
  } finally {
    closeSync(descriptor);
  }
}

function verifyFreshArtifact(input: {
  filePath: string;
  fileMtimeMs: number;
  trajectoryStartedAt: number;
  trajectoryEndedAt: number;
  scenarioStartedAt: number;
  scenarioEndedAt: number;
  clockSkewMs: number;
  nowMs: number;
}): void {
  if (
    input.trajectoryStartedAt < input.scenarioStartedAt - input.clockSkewMs ||
    input.trajectoryEndedAt > input.scenarioEndedAt + input.clockSkewMs
  ) {
    fail(`${input.filePath} falls outside the scenario observation interval`);
  }
  if (
    input.trajectoryEndedAt < input.trajectoryStartedAt ||
    input.fileMtimeMs < input.scenarioStartedAt - input.clockSkewMs ||
    input.fileMtimeMs > input.nowMs + input.clockSkewMs
  ) {
    fail(
      `${input.filePath} is stale, future-dated, or has inverted timestamps`,
    );
  }
}

/**
 * Verify every trajectory artifact in an isolated run and return digests that
 * can be compared with independently signed observation references.
 */
export function verifyScenarioTrajectories(
  input: VerifyScenarioTrajectoriesInput,
): VerifiedScenarioTrajectorySet {
  const startedAt = requireIso(
    input.scenarioStartedAtIso,
    "scenarioStartedAtIso",
  );
  const endedAt = requireIso(input.scenarioEndedAtIso, "scenarioEndedAtIso");
  if (endedAt < startedAt) {
    fail("scenario interval ends before it starts");
  }
  requireString(input.runId, "runId");
  requireString(input.scenarioId, "scenarioId");
  requireString(input.environment, "environment");
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    fail("now must be a valid Date");
  }
  const maxRunDirectoryAgeMs =
    input.maxRunDirectoryAgeMs ?? DEFAULT_MAX_RUN_DIRECTORY_AGE_MS;
  const clockSkewMs = input.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  if (
    !Number.isSafeInteger(maxRunDirectoryAgeMs) ||
    maxRunDirectoryAgeMs < 0 ||
    !Number.isSafeInteger(clockSkewMs) ||
    clockSkewMs < 0
  ) {
    fail("freshness windows must be non-negative safe integers");
  }

  const runDirInput = path.resolve(input.runDir);
  const runDirMetadata = lstatSync(runDirInput, { bigint: true });
  if (runDirMetadata.isSymbolicLink() || !runDirMetadata.isDirectory()) {
    fail("runDir must be a real directory rather than a symbolic link");
  }
  const runDirectoryRealPath = realpathSync(runDirInput);
  const runDirectoryMetadata = statSync(runDirectoryRealPath, {
    bigint: true,
  });
  if (
    runDirectoryMetadata.dev !== runDirMetadata.dev ||
    runDirectoryMetadata.ino !== runDirMetadata.ino
  ) {
    fail("runDir identity changed while resolving its real path");
  }
  const freshnessTimestamp = Math.max(
    Number(runDirectoryMetadata.birthtimeMs),
    Number(runDirectoryMetadata.ctimeMs),
  );
  if (
    freshnessTimestamp < startedAt - maxRunDirectoryAgeMs - clockSkewMs ||
    freshnessTimestamp > now.getTime() + clockSkewMs
  ) {
    fail("runDir was not freshly created for this execution");
  }

  const trajectoriesInput = path.join(runDirectoryRealPath, "trajectories");
  const trajectoryRootMetadata = lstatSync(trajectoriesInput, {
    bigint: true,
  });
  if (
    trajectoryRootMetadata.isSymbolicLink() ||
    !trajectoryRootMetadata.isDirectory()
  ) {
    fail("trajectories root must be a real directory");
  }
  const trajectoriesRoot = realpathSync(trajectoriesInput);
  const resolvedTrajectoryRootMetadata = statSync(trajectoriesRoot, {
    bigint: true,
  });
  if (!isWithin(runDirectoryRealPath, trajectoriesRoot)) {
    fail("trajectories root escapes runDir");
  }
  if (
    resolvedTrajectoryRootMetadata.dev !== trajectoryRootMetadata.dev ||
    resolvedTrajectoryRootMetadata.ino !== trajectoryRootMetadata.ino
  ) {
    fail("trajectories root identity changed while resolving its real path");
  }

  const files = collectTrajectoryFiles(trajectoriesRoot);
  if (files.length === 0) {
    fail("produced no immutable trajectory JSON");
  }
  const discoveredRelativePaths = files.map((filePath) =>
    path.relative(runDirectoryRealPath, filePath).split(path.sep).join("/"),
  );
  if (input.expectedRelativePaths !== undefined) {
    const expected = input.expectedRelativePaths.map((relativePath, index) =>
      validateRelativePath(relativePath, `expectedRelativePaths[${index}]`),
    );
    if (new Set(expected).size !== expected.length) {
      fail("expectedRelativePaths contains duplicates");
    }
    const expectedSorted = [...expected].sort();
    const discoveredSorted = [...discoveredRelativePaths].sort();
    if (
      expectedSorted.length !== discoveredSorted.length ||
      expectedSorted.some(
        (relativePath, index) => relativePath !== discoveredSorted[index],
      )
    ) {
      fail("discovered artifacts do not exactly match expectedRelativePaths");
    }
  }

  const trajectoryIds = new Set<string>();
  const artifactIdentities = new Set<string>();
  const verified: VerifiedScenarioTrajectory[] = [];
  for (const [fileIndex, filePath] of files.entries()) {
    const realFilePath = realpathSync(filePath);
    if (!isWithin(trajectoriesRoot, realFilePath)) {
      fail(`${filePath} escapes the trajectories root`);
    }
    const { bytes, metadata: fileMetadata } =
      readImmutableRegularFile(realFilePath);
    const finalRealFilePath = realpathSync(filePath);
    if (
      finalRealFilePath !== realFilePath ||
      !isWithin(trajectoriesRoot, finalRealFilePath)
    ) {
      fail(`${filePath} changed identity or escaped during verification`);
    }
    const fileIdentity = `${fileMetadata.dev}:${fileMetadata.ino}`;
    if (artifactIdentities.has(fileIdentity)) {
      fail(`${filePath} aliases an already verified artifact`);
    }
    artifactIdentities.add(fileIdentity);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      // error-policy:J2 retain the parser failure beneath the artifact boundary.
      throw new Error(
        `provider-qualified trajectory verification ${filePath} is not valid JSON`,
        { cause: error },
      );
    }
    const trajectory = asRecord(parsed, `trajectory[${fileIndex}]`);
    const trajectoryId = requireString(
      trajectory.trajectoryId,
      `trajectory[${fileIndex}].trajectoryId`,
    );
    if (trajectoryIds.has(trajectoryId)) {
      fail(`trajectoryId "${trajectoryId}" is duplicated`);
    }
    trajectoryIds.add(trajectoryId);
    if (path.basename(filePath) !== `${trajectoryId}.json`) {
      fail(
        `${filePath} filename does not match trajectoryId "${trajectoryId}"`,
      );
    }
    if (trajectory.runId !== input.runId) {
      fail(`${filePath} has the wrong runId`);
    }
    if (trajectory.scenarioId !== input.scenarioId) {
      fail(`${filePath} has the wrong scenarioId`);
    }
    if (trajectory.status !== "finished") {
      fail(`${filePath} is not finished`);
    }
    const trajectoryStartedAt = requireTimestamp(
      trajectory.startedAt,
      `trajectory[${fileIndex}].startedAt`,
    );
    const trajectoryEndedAt = requireTimestamp(
      trajectory.endedAt,
      `trajectory[${fileIndex}].endedAt`,
    );
    verifyFreshArtifact({
      filePath,
      fileMtimeMs: Number(fileMetadata.mtimeMs),
      trajectoryStartedAt,
      trajectoryEndedAt,
      scenarioStartedAt: startedAt,
      scenarioEndedAt: endedAt,
      clockSkewMs,
      nowMs: now.getTime(),
    });

    if (!Array.isArray(trajectory.stages) || trajectory.stages.length === 0) {
      fail(`${filePath} contains no completed stages`);
    }
    const stageIds = new Set<string>();
    const stages: VerifiedTrajectoryStage[] = [];
    for (const [stageIndex, rawStage] of trajectory.stages.entries()) {
      const stage = asRecord(
        rawStage,
        `trajectory[${fileIndex}].stages[${stageIndex}]`,
      );
      const stageId = requireString(
        stage.stageId,
        `trajectory[${fileIndex}].stages[${stageIndex}].stageId`,
      );
      if (stageIds.has(stageId)) {
        fail(`${filePath} contains duplicate stageId "${stageId}"`);
      }
      stageIds.add(stageId);
      const kind = requireString(
        stage.kind,
        `trajectory[${fileIndex}].stages[${stageIndex}].kind`,
      );
      const stageStartedAt = requireTimestamp(
        stage.startedAt,
        `trajectory[${fileIndex}].stages[${stageIndex}].startedAt`,
      );
      const stageEndedAt = requireTimestamp(
        stage.endedAt,
        `trajectory[${fileIndex}].stages[${stageIndex}].endedAt`,
      );
      if (
        stageStartedAt < trajectoryStartedAt ||
        stageEndedAt > trajectoryEndedAt ||
        stageEndedAt < stageStartedAt
      ) {
        fail(`${filePath} stage "${stageId}" has invalid interval bounds`);
      }
      const canonicalStage = stageCanonicalValue(
        stage,
        `trajectory[${fileIndex}].stages[${stageIndex}]`,
      );
      let tool: VerifiedTrajectoryStage["tool"];
      if (kind === "tool") {
        const recordedTool = asRecord(
          stage.tool,
          `trajectory[${fileIndex}].stages[${stageIndex}].tool`,
        );
        const name = requireString(
          recordedTool.name,
          `trajectory[${fileIndex}].stages[${stageIndex}].tool.name`,
        );
        if (typeof recordedTool.success !== "boolean") {
          fail(
            `trajectory[${fileIndex}].stages[${stageIndex}].tool.success must be a boolean`,
          );
        }
        tool = {
          name,
          argsSha256: canonicalSha256(
            recordedTool.args,
            `trajectory[${fileIndex}].stages[${stageIndex}].tool.args`,
          ),
          resultSha256: canonicalSha256(
            recordedTool.result,
            `trajectory[${fileIndex}].stages[${stageIndex}].tool.result`,
          ),
          success: recordedTool.success,
        };
      }
      stages.push({
        stageId,
        kind,
        sha256: createHash("sha256")
          .update(canonicalJson(canonicalStage), "utf8")
          .digest("hex"),
        startedAtIso: new Date(stageStartedAt).toISOString(),
        endedAtIso: new Date(stageEndedAt).toISOString(),
        ...(tool === undefined ? {} : { tool }),
      });
    }
    const relativePath = discoveredRelativePaths[fileIndex];
    verified.push({
      artifact: {
        trajectoryId,
        relativePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        recorder: {
          implementation: "@elizaos/core/trajectory-recorder",
          version: "1",
          environment: input.environment,
        },
      },
      stages: stages as [VerifiedTrajectoryStage, ...VerifiedTrajectoryStage[]],
    });
  }

  verified.sort((left, right) =>
    left.artifact.trajectoryId.localeCompare(right.artifact.trajectoryId),
  );
  const setSha256 = canonicalSha256(
    verified.map((trajectory) => ({
      artifact: trajectory.artifact,
      stages: trajectory.stages,
    })),
    "verifiedTrajectories",
  );
  const finalRunDirMetadata = lstatSync(runDirInput, { bigint: true });
  const finalTrajectoryRootMetadata = lstatSync(trajectoriesInput, {
    bigint: true,
  });
  if (
    finalRunDirMetadata.dev !== runDirMetadata.dev ||
    finalRunDirMetadata.ino !== runDirMetadata.ino ||
    finalTrajectoryRootMetadata.dev !== trajectoryRootMetadata.dev ||
    finalTrajectoryRootMetadata.ino !== trajectoryRootMetadata.ino ||
    realpathSync(runDirInput) !== runDirectoryRealPath ||
    realpathSync(trajectoriesInput) !== trajectoriesRoot
  ) {
    fail("run directory identity changed during verification");
  }
  return validateVerifiedScenarioTrajectorySet({
    runId: input.runId,
    scenarioId: input.scenarioId,
    scenarioStartedAtIso: new Date(startedAt).toISOString(),
    scenarioEndedAtIso: new Date(endedAt).toISOString(),
    runDirectoryRealPath,
    verifiedAtIso: now.toISOString(),
    setSha256,
    trajectories: verified as [
      VerifiedScenarioTrajectory,
      ...VerifiedScenarioTrajectory[],
    ],
  });
}
