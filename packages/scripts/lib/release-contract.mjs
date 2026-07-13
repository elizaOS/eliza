/**
 * Defines the immutable npm release candidate and its monotonic state machine.
 * The contract is deterministic and network-free: callers provide an explicit
 * package allowlist, while this module validates versions, dependency ranges,
 * entrypoints, ordering, and retry-safe phase transitions.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import { listPackages } from "./workspaces.mjs";

export const RELEASE_PLAN_SCHEMA_VERSION = 1;
export const RELEASE_STATE_SCHEMA_VERSION = 1;

export const RELEASE_PHASES = Object.freeze([
  "planned",
  "built-packed",
  "candidate-recorded",
  "registry-bound",
  "registry-staged",
  "registry-verified",
  "channel-promoted",
  "git-bound",
  "git-tagged",
  "release-published",
  "version-sync-pr",
]);

const DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
]);
const RUNTIME_DEPENDENCY_SECTIONS = new Set([
  "dependencies",
  "optionalDependencies",
]);
const RESERVED_RELEASE_VERSIONS = new Set([
  "2.0.3-beta.8",
  "2.0.3-beta.9",
  "2.0.3-beta.10",
]);

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeJson(value, at = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`${at} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry, index) => normalizeJson(entry, `${at}[${index}]`));
  if (typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort(compareText)) {
      const entry = value[key];
      if (entry === undefined) throw new TypeError(`${at}.${key} is undefined`);
      normalized[key] = normalizeJson(entry, `${at}.${key}`);
    }
    return normalized;
  }
  throw new TypeError(`${at} contains a non-JSON value`);
}

/** Serialize JSON with recursively sorted object keys and one trailing newline. */
export function stableStringify(value) {
  return `${JSON.stringify(normalizeJson(value), null, 2)}\n`;
}

export function sha512Hex(value) {
  return createHash("sha512").update(value).digest("hex");
}

export function sha512Integrity(value) {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

export function validateExactVersion(version) {
  if (typeof version !== "string" || semver.valid(version) !== version) {
    throw new Error(
      `Release version must be exact canonical semver, received ${JSON.stringify(version)}`,
    );
  }
  if (RESERVED_RELEASE_VERSIONS.has(version)) {
    throw new Error(
      `Release version ${version} is reserved failed-release residue and cannot be reused`,
    );
  }
  return version;
}

export function validateReleaseChannel(channel) {
  if (
    typeof channel !== "string" ||
    !/^[a-z][a-z0-9._-]*$/i.test(channel) ||
    channel.length > 64
  ) {
    throw new Error(`Invalid npm release channel ${JSON.stringify(channel)}`);
  }
  return channel;
}

export function validateCommitSha(value, fieldName) {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/i.test(value)) {
    throw new Error(`${fieldName} must be a full Git object ID`);
  }
  return value.toLowerCase();
}

export function validateReleaseIdentity({
  version,
  channel,
  sourceSha,
  expectedCommit,
}) {
  const identity = {
    version: validateExactVersion(version),
    channel: validateReleaseChannel(channel),
    sourceSha: validateCommitSha(sourceSha, "sourceSha"),
    expectedCommit: validateCommitSha(expectedCommit, "expectedCommit"),
  };
  if (identity.sourceSha !== identity.expectedCommit) {
    throw new Error(
      `sourceSha ${identity.sourceSha} does not equal expectedCommit ${identity.expectedCommit}; rebase and create a new candidate`,
    );
  }
  return identity;
}

export function deriveReleaseCandidateTag(identity, packageNames) {
  const validatedIdentity = validateReleaseIdentity(identity);
  if (
    !Array.isArray(packageNames) ||
    packageNames.length === 0 ||
    packageNames.some(
      (name) => typeof name !== "string" || name.length === 0,
    ) ||
    new Set(packageNames).size !== packageNames.length
  ) {
    throw new Error("Candidate tag requires unique package names");
  }
  const seed = stableStringify({
    identity: validatedIdentity,
    packageNames,
  });
  return `eliza-candidate-${sha512Hex(seed).slice(0, 16)}`;
}

export function loadReleaseCohort(filePath) {
  const source = readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    // error-policy:J2 name the explicit release input that could not be parsed
    throw new Error(`Invalid release cohort JSON in ${filePath}`, {
      cause: error,
    });
  }
  if (
    parsed?.schemaVersion !== 1 ||
    !Array.isArray(parsed.packages) ||
    parsed.packages.length === 0
  ) {
    throw new Error(
      `${filePath} must contain { "schemaVersion": 1, "packages": [name, ...] }`,
    );
  }
  const packageNames = parsed.packages.map((name, index) => {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        `${filePath} packages[${index}] must be a non-empty package name`,
      );
    }
    return name;
  });
  const uniqueNames = new Set(packageNames);
  if (uniqueNames.size !== packageNames.length)
    throw new Error(`${filePath} contains duplicate package names`);
  return [...uniqueNames].sort(compareText);
}

function optionalString(value, field, packageName) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${packageName} has an invalid ${field} entrypoint`);
  }
  return value;
}

function normalizeBins(value, packageName) {
  if (value === undefined) return {};
  if (typeof value === "string") {
    const command = packageName.includes("/")
      ? packageName.slice(packageName.lastIndexOf("/") + 1)
      : packageName;
    return { [command]: optionalString(value, "bin", packageName) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${packageName} has invalid bin metadata`);
  }
  const bins = {};
  for (const command of Object.keys(value).sort(compareText)) {
    bins[command] = optionalString(
      value[command],
      `bin.${command}`,
      packageName,
    );
  }
  return bins;
}

export function collectEntrypointMetadata(packageJson) {
  const packageName = packageJson.name;
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error("Publishable package is missing a name");
  }
  const packageType = packageJson.type === undefined ? null : packageJson.type;
  if (
    packageType !== null &&
    packageType !== "module" &&
    packageType !== "commonjs"
  ) {
    throw new Error(
      `${packageName} has invalid package type ${JSON.stringify(packageType)}`,
    );
  }
  const exportsMetadata =
    packageJson.exports === undefined
      ? null
      : normalizeJson(packageJson.exports);
  return {
    packageType,
    main: optionalString(packageJson.main, "main", packageName),
    module: optionalString(packageJson.module, "module", packageName),
    types: optionalString(packageJson.types, "types", packageName),
    bin: normalizeBins(packageJson.bin, packageName),
    exports: exportsMetadata,
  };
}

function validateDependencyRange({
  fromName,
  section,
  dependencyName,
  range,
  targetVersion,
}) {
  if (typeof range !== "string" || range.startsWith("workspace:")) {
    throw new Error(
      `${fromName} ${section}.${dependencyName} must be a published semver range, received ${range}`,
    );
  }
  const validRange = semver.validRange(range);
  if (
    !validRange ||
    !semver.satisfies(targetVersion, validRange, { includePrerelease: true })
  ) {
    throw new Error(
      `${fromName} ${section}.${dependencyName} range ${range} does not accept workspace version ${targetVersion}`,
    );
  }
}

function stronglyConnectedPublishOrder(graph) {
  const names = Object.keys(graph).sort(compareText);
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(name) {
    indices.set(name, nextIndex);
    lowLinks.set(name, nextIndex);
    nextIndex += 1;
    stack.push(name);
    onStack.add(name);

    for (const dependency of graph[name]) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          name,
          Math.min(lowLinks.get(name), lowLinks.get(dependency)),
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          name,
          Math.min(lowLinks.get(name), indices.get(dependency)),
        );
      }
    }

    if (lowLinks.get(name) !== indices.get(name)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === name) break;
    }
    components.push(component.sort(compareText));
  }

  for (const name of names) if (!indices.has(name)) visit(name);
  const componentByName = new Map();
  components.forEach((component, index) => {
    for (const name of component) componentByName.set(name, index);
  });
  const componentDependencies = components.map(() => new Set());
  for (const [name, dependencies] of Object.entries(graph)) {
    const from = componentByName.get(name);
    for (const dependency of dependencies) {
      const target = componentByName.get(dependency);
      if (from !== target) componentDependencies[from].add(target);
    }
  }
  const orderedComponents = [];
  const visited = new Set();
  function order(index) {
    if (visited.has(index)) return;
    visited.add(index);
    const dependencies = [...componentDependencies[index]].sort((a, b) =>
      compareText(components[a][0], components[b][0]),
    );
    for (const dependency of dependencies) order(dependency);
    orderedComponents.push(index);
  }
  for (const index of components.keys()) order(index);

  return {
    publishOrder: orderedComponents.flatMap((index) => components[index]),
    dependencyCycles: components
      .filter((component) => component.length > 1)
      .sort((a, b) => compareText(a[0], b[0])),
  };
}

function validatePlanPath(value, fieldName) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error(`${fieldName} must be a canonical relative path`);
  }
  return value;
}

function validateSha512Pair(record, fieldName) {
  if (
    typeof record?.sha512 !== "string" ||
    !/^[0-9a-f]{128}$/.test(record.sha512) ||
    typeof record.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(record.integrity)
  ) {
    throw new Error(`${fieldName} requires SHA-512 hex and SRI integrity`);
  }
  const integrityFromHex = `sha512-${Buffer.from(record.sha512, "hex").toString("base64")}`;
  if (integrityFromHex !== record.integrity) {
    throw new Error(`${fieldName} SHA-512 encodings disagree`);
  }
}

function validateRecordedEntrypoints(packageRecord) {
  const entrypoints = packageRecord.entrypoints;
  if (
    !entrypoints ||
    typeof entrypoints !== "object" ||
    Array.isArray(entrypoints)
  ) {
    throw new Error(`${packageRecord.name} is missing entrypoint metadata`);
  }
  const normalized = collectEntrypointMetadata({
    name: packageRecord.name,
    type:
      entrypoints.packageType === null ? undefined : entrypoints.packageType,
    main: entrypoints.main === null ? undefined : entrypoints.main,
    module: entrypoints.module === null ? undefined : entrypoints.module,
    types: entrypoints.types === null ? undefined : entrypoints.types,
    bin: entrypoints.bin,
    exports: entrypoints.exports,
  });
  if (stableStringify(normalized) !== stableStringify(entrypoints)) {
    throw new Error(`${packageRecord.name} has malformed entrypoint metadata`);
  }
}

/** Validate every field that later registry and Git side effects consume. */
export function validateReleasePlan(plan) {
  if (
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    plan.schemaVersion !== RELEASE_PLAN_SCHEMA_VERSION
  ) {
    throw new Error("Malformed release plan");
  }
  const identity = validateReleaseIdentity(plan);
  if (
    plan.version !== identity.version ||
    plan.channel !== identity.channel ||
    plan.sourceSha !== identity.sourceSha ||
    plan.expectedCommit !== identity.expectedCommit
  ) {
    throw new Error("Release plan identity is not canonical");
  }
  if (
    !plan.build ||
    typeof plan.build.command !== "string" ||
    plan.build.command.length === 0 ||
    !Array.isArray(plan.build.args) ||
    plan.build.args.some((argument) => typeof argument !== "string") ||
    !Array.isArray(plan.packages) ||
    plan.packages.length === 0 ||
    !Array.isArray(plan.publishOrder)
  ) {
    throw new Error("Release plan omits required build or package metadata");
  }

  const packageNames = plan.packages.map(
    (packageRecord) => packageRecord?.name,
  );
  if (
    packageNames.some(
      (name) => typeof name !== "string" || name.length === 0,
    ) ||
    new Set(packageNames).size !== packageNames.length ||
    stableStringify(plan.publishOrder) !== stableStringify(packageNames)
  ) {
    throw new Error("Release plan package order is malformed");
  }
  if (plan.candidateTag !== deriveReleaseCandidateTag(identity, packageNames)) {
    throw new Error("Release plan candidate tag does not match its identity");
  }
  validateReleaseChannel(plan.candidateTag);

  const cohort = new Set(packageNames);
  const tarballNames = new Set();
  for (const packageRecord of plan.packages) {
    if (packageRecord.version !== plan.version) {
      throw new Error(`${packageRecord.name} has the wrong planned version`);
    }
    const directory = validatePlanPath(
      packageRecord.directory,
      `${packageRecord.name} directory`,
    );
    validateRecordedEntrypoints(packageRecord);
    if (!Array.isArray(packageRecord.internalDependencies)) {
      throw new Error(`${packageRecord.name} dependencies are malformed`);
    }
    const hardDependencies = new Set();
    for (const dependency of packageRecord.internalDependencies) {
      if (
        !dependency ||
        typeof dependency.name !== "string" ||
        !DEPENDENCY_SECTIONS.includes(dependency.section) ||
        typeof dependency.range !== "string" ||
        typeof dependency.targetVersion !== "string" ||
        typeof dependency.inCohort !== "boolean" ||
        dependency.inCohort !== cohort.has(dependency.name)
      ) {
        throw new Error(
          `${packageRecord.name} dependency metadata is malformed`,
        );
      }
      validateDependencyRange({
        fromName: packageRecord.name,
        section: dependency.section,
        dependencyName: dependency.name,
        range: dependency.range,
        targetVersion: validateExactVersion(dependency.targetVersion),
      });
      if (dependency.inCohort && dependency.targetVersion !== plan.version) {
        throw new Error(
          `${packageRecord.name} dependency version is not the cohort version`,
        );
      }
      if (RUNTIME_DEPENDENCY_SECTIONS.has(dependency.section)) {
        if (!dependency.inCohort) {
          throw new Error(
            `${packageRecord.name} has an incomplete runtime cohort`,
          );
        }
        hardDependencies.add(dependency.name);
      }
    }

    const manifest = packageRecord.manifest;
    if (!manifest || manifest.path !== `${directory}/package.json`) {
      throw new Error(`${packageRecord.name} manifest path is malformed`);
    }
    validateSha512Pair(manifest, `${packageRecord.name} manifest`);

    const tarball = packageRecord.tarball;
    if (
      !tarball ||
      typeof tarball.filename !== "string" ||
      tarball.filename.length === 0 ||
      tarball.filename.includes("/") ||
      tarball.filename.includes("\\") ||
      tarball.path !== `tarballs/${tarball.filename}` ||
      !Number.isSafeInteger(tarball.size) ||
      tarball.size <= 0 ||
      (tarball.npmShasum !== null &&
        (typeof tarball.npmShasum !== "string" ||
          !/^[0-9a-f]{40}$/.test(tarball.npmShasum)))
    ) {
      throw new Error(`${packageRecord.name} tarball metadata is malformed`);
    }
    if (tarballNames.has(tarball.filename)) {
      throw new Error(`Duplicate tarball filename ${tarball.filename}`);
    }
    tarballNames.add(tarball.filename);
    validateSha512Pair(tarball, `${packageRecord.name} tarball`);

    const graphDependencies = plan.dependencyGraph?.[packageRecord.name];
    if (
      !Array.isArray(graphDependencies) ||
      new Set(graphDependencies).size !== graphDependencies.length ||
      graphDependencies.some((name) => !cohort.has(name)) ||
      stableStringify(graphDependencies) !==
        stableStringify([...hardDependencies].sort(compareText))
    ) {
      throw new Error(`${packageRecord.name} dependency graph is malformed`);
    }
  }

  if (
    !plan.dependencyGraph ||
    typeof plan.dependencyGraph !== "object" ||
    Array.isArray(plan.dependencyGraph) ||
    stableStringify(Object.keys(plan.dependencyGraph).sort(compareText)) !==
      stableStringify([...packageNames].sort(compareText))
  ) {
    throw new Error("Release dependency graph keys do not match the cohort");
  }
  const recomputed = stronglyConnectedPublishOrder(plan.dependencyGraph);
  if (
    stableStringify(recomputed.publishOrder) !==
      stableStringify(plan.publishOrder) ||
    stableStringify(recomputed.dependencyCycles) !==
      stableStringify(plan.dependencyCycles)
  ) {
    throw new Error("Release dependency order does not match its graph");
  }
  return plan;
}

/** Resolve and validate exactly the packages named by the release allowlist. */
export function resolveReleaseCohort({ repoRoot, packageNames, version }) {
  validateExactVersion(version);
  if (!Array.isArray(packageNames) || packageNames.length === 0) {
    throw new Error("An explicit non-empty package allowlist is required");
  }
  const requested = [...packageNames];
  const unique = new Set(requested);
  if (unique.size !== requested.length)
    throw new Error("Release package allowlist contains duplicates");

  const workspacePackages = listPackages({ repoRoot });
  const workspaceByName = new Map(
    workspacePackages
      .filter(({ name }) => typeof name === "string" && name.length > 0)
      .map((workspacePackage) => [workspacePackage.name, workspacePackage]),
  );
  const cohortSet = new Set(requested);
  const recordsByName = new Map();
  const graph = {};

  for (const packageName of [...requested].sort(compareText)) {
    const workspacePackage = workspaceByName.get(packageName);
    if (!workspacePackage)
      throw new Error(
        `Release package ${packageName} is not a workspace package`,
      );
    const manifest = workspacePackage.packageJson;
    if (manifest.private === true)
      throw new Error(`Release package ${packageName} is private`);
    if (manifest.version !== version) {
      throw new Error(
        `Release package ${packageName} has version ${manifest.version}, expected ${version}`,
      );
    }
    if (
      packageName.startsWith("@") &&
      manifest.publishConfig?.access !== "public"
    ) {
      throw new Error(
        `Scoped release package ${packageName} must declare publishConfig.access=public before packing`,
      );
    }

    const internalDependencies = [];
    const graphDependencies = new Set();
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = manifest[section];
      if (dependencies === undefined) continue;
      if (
        !dependencies ||
        typeof dependencies !== "object" ||
        Array.isArray(dependencies)
      ) {
        throw new Error(`${packageName} ${section} must be an object`);
      }
      for (const dependencyName of Object.keys(dependencies).sort(
        compareText,
      )) {
        const target = workspaceByName.get(dependencyName);
        const range = dependencies[dependencyName];
        if (!target) {
          if (typeof range === "string" && range.startsWith("workspace:")) {
            throw new Error(
              `${packageName} ${section}.${dependencyName} targets a missing workspace package`,
            );
          }
          continue;
        }
        const targetVersion = validateExactVersion(target.packageJson.version);
        validateDependencyRange({
          fromName: packageName,
          section,
          dependencyName,
          range,
          targetVersion,
        });
        if (
          RUNTIME_DEPENDENCY_SECTIONS.has(section) &&
          target.packageJson.private === true
        ) {
          throw new Error(
            `${packageName} ${section}.${dependencyName} targets a private package`,
          );
        }
        const inCohort = cohortSet.has(dependencyName);
        if (RUNTIME_DEPENDENCY_SECTIONS.has(section) && !inCohort) {
          throw new Error(
            `${packageName} ${section}.${dependencyName} is a runtime workspace dependency missing from the explicit release cohort`,
          );
        }
        internalDependencies.push({
          name: dependencyName,
          section,
          range,
          targetVersion,
          inCohort,
        });
        if (inCohort && RUNTIME_DEPENDENCY_SECTIONS.has(section))
          graphDependencies.add(dependencyName);
      }
    }
    graph[packageName] = [...graphDependencies].sort(compareText);
    recordsByName.set(packageName, {
      name: packageName,
      directory: workspacePackage.dir.split(path.sep).join("/"),
      version,
      internalDependencies,
      entrypoints: collectEntrypointMetadata(manifest),
    });
  }

  const { publishOrder, dependencyCycles } =
    stronglyConnectedPublishOrder(graph);
  return {
    packages: publishOrder.map((name) => recordsByName.get(name)),
    dependencyGraph: graph,
    dependencyCycles,
    publishOrder,
  };
}

export function createReleaseState(planIntegrity, plannedEvidence) {
  if (
    typeof planIntegrity !== "string" ||
    !planIntegrity.startsWith("sha512-")
  ) {
    throw new Error("Release state requires the candidate plan integrity");
  }
  return {
    schemaVersion: RELEASE_STATE_SCHEMA_VERSION,
    planIntegrity,
    phase: "planned",
    transitions: [
      { phase: "planned", evidence: normalizeJson(plannedEvidence) },
    ],
  };
}

/** Validate that every recorded phase is present exactly once and in order. */
export function validateReleaseState(state) {
  if (
    state?.schemaVersion !== RELEASE_STATE_SCHEMA_VERSION ||
    typeof state.planIntegrity !== "string" ||
    !state.planIntegrity.startsWith("sha512-") ||
    !Array.isArray(state.transitions)
  ) {
    throw new Error("Malformed release state");
  }
  const currentIndex = RELEASE_PHASES.indexOf(state.phase);
  if (
    currentIndex < 0 ||
    state.transitions.length !== currentIndex + 1 ||
    state.transitions.some(
      (transition, index) =>
        !transition ||
        transition.phase !== RELEASE_PHASES[index] ||
        !("evidence" in transition),
    )
  ) {
    throw new Error("Release state has an invalid transition history");
  }
  for (const transition of state.transitions)
    normalizeJson(transition.evidence);
  return state;
}

/** Read evidence only from a phase that the validated state already reached. */
export function releaseTransitionEvidence(state, phase) {
  validateReleaseState(state);
  const targetIndex = RELEASE_PHASES.indexOf(phase);
  const currentIndex = RELEASE_PHASES.indexOf(state.phase);
  if (targetIndex < 0) throw new Error(`Unknown release phase ${phase}`);
  if (targetIndex > currentIndex) {
    throw new Error(`Release has not reached phase ${phase}`);
  }
  return state.transitions[targetIndex].evidence;
}

/** Advance exactly one phase; identical retries are no-ops and conflicts fail. */
export function advanceReleaseState(state, targetPhase, evidence) {
  validateReleaseState(state);
  const currentIndex = RELEASE_PHASES.indexOf(state.phase);
  const targetIndex = RELEASE_PHASES.indexOf(targetPhase);
  if (currentIndex < 0 || targetIndex < 0)
    throw new Error(`Unknown release phase ${targetPhase}`);
  const normalizedEvidence = normalizeJson(evidence);
  if (targetIndex === currentIndex) {
    const current = state.transitions.at(-1);
    if (
      stableStringify(current.evidence) !== stableStringify(normalizedEvidence)
    ) {
      throw new Error(
        `Conflicting evidence for already-recorded phase ${targetPhase}`,
      );
    }
    return state;
  }
  if (targetIndex !== currentIndex + 1) {
    throw new Error(
      `Invalid release transition ${state.phase} -> ${targetPhase}`,
    );
  }
  return {
    ...state,
    phase: targetPhase,
    transitions: [
      ...state.transitions,
      { phase: targetPhase, evidence: normalizedEvidence },
    ],
  };
}
