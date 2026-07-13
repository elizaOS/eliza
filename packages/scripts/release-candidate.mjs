#!/usr/bin/env node
/**
 * Command boundary for immutable npm candidates, registry resume, exact Git
 * tags, and GitHub Release finalization. Every side effect requires explicit
 * paths and identities; public services additionally require an opt-in flag.
 */

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAndPackReleaseCandidate,
  loadReleasePlan,
  recordReleaseTransition,
  verifyReleaseCandidate,
} from "./lib/release-candidate.mjs";
import { loadReleaseCohort, stableStringify } from "./lib/release-contract.mjs";
import { pushAtomicReleaseRefs, pushReleaseTag } from "./lib/release-git.mjs";
import { publishGitHubRelease } from "./lib/release-github.mjs";
import {
  inspectReleaseRegistry,
  normalizeRegistryUrl,
  publishReleaseCandidate,
  verifyPromotedReleaseCandidate,
} from "./lib/release-registry.mjs";
import { validatePublicReleaseInputs } from "./lib/release-workflow.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function argumentValue(args, name, { required = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (!args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function argumentValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    if (!args[index + 1]) throw new Error(`${name} requires a value`);
    values.push(args[index + 1]);
  }
  return values;
}

function repoRoot(args) {
  return path.resolve(argumentValue(args, "--repo-root") || DEFAULT_REPO_ROOT);
}

function candidateDirectory(args) {
  return path.resolve(argumentValue(args, "--candidate", { required: true }));
}

function registryOptions(args) {
  const registryUrl = normalizeRegistryUrl(
    argumentValue(args, "--registry", { required: true }),
  );
  if (
    new URL(registryUrl).hostname === "registry.npmjs.org" &&
    !args.includes("--allow-public-registry")
  ) {
    throw new Error("Public npm access requires --allow-public-registry");
  }
  const tokenEnv = argumentValue(args, "--token-env") || "NODE_AUTH_TOKEN";
  return { registryUrl, token: process.env[tokenEnv] };
}

function githubOptions(args) {
  const apiUrl = argumentValue(args, "--api-url") || "https://api.github.com/";
  if (
    new URL(apiUrl).hostname === "api.github.com" &&
    !args.includes("--allow-public-github")
  ) {
    throw new Error("Public GitHub access requires --allow-public-github");
  }
  const tokenEnv = argumentValue(args, "--token-env") || "GITHUB_TOKEN";
  return { apiUrl, token: process.env[tokenEnv] };
}

function writeGitHubOutputs(filePath, values) {
  const lines = Object.entries(values).map(([name, value]) => {
    if (typeof value === "string" || typeof value === "boolean") {
      return `${name}=${value}`;
    }
    throw new Error(`GitHub output ${name} must be a string or boolean`);
  });
  appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function readEvidence(filePath) {
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    // error-policy:J2 identify the transition evidence that cannot be recorded
    throw new Error(`Invalid transition evidence ${filePath}`, {
      cause: error,
    });
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("Transition evidence must be a JSON object");
  }
  return evidence;
}

function usage() {
  return `release-candidate commands:
  inputs --source-sha <sha> --version <semver> --channel <beta|latest>
         [--github-output <path>]
  candidate --cohort <json> --candidate <dir> --version <semver> --channel <tag>
            --source-sha <sha> --expected-commit <sha> --build-command <program>
            [--build-arg <arg> ...] [--npm-command npm] [--repo-root <dir>]
  verify --candidate <dir> [--source-sha <sha> --version <semver> --channel <tag>]
         [--repo-root <dir>]
  inspect --candidate <dir> --registry <url> [--token-env <name>]
  publish --candidate <dir> --registry <url> [--npm-command npm] [--token-env <name>]
  verify-promoted --candidate <dir> --registry <url> [--token-env <name>]
  push-refs --candidate <dir> --remote <name-or-url> --branch <name> --tag <tag>
            --expected-old <sha> [--repo-root <dir>]
  push-tag --candidate <dir> --remote <name-or-url> --tag <tag>
           [--repo-root <dir>]
  publish-release --candidate <dir> --repository <owner/name> --tag <tag>
                  [--api-url <url>] [--token-env <name>] [--repo-root <dir>]
  transition --candidate <dir> --to <phase> --evidence <json-file>

Public npm or GitHub access additionally requires its matching --allow-public-* flag.`;
}

export async function main(args = process.argv.slice(2)) {
  const [command] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return null;
  }
  if (command === "inputs") {
    const result = validatePublicReleaseInputs({
      sourceSha: argumentValue(args, "--source-sha", { required: true }),
      version: argumentValue(args, "--version", { required: true }),
      channel: argumentValue(args, "--channel", { required: true }),
    });
    const outputPath = argumentValue(args, "--github-output");
    if (outputPath) {
      writeGitHubOutputs(outputPath, {
        source_sha: result.sourceSha,
        version: result.version,
        channel: result.channel,
        tag: result.tag,
        prerelease: result.prerelease,
        artifact_name: result.artifactName,
      });
    }
    console.log(stableStringify(result).trim());
    return result;
  }
  if (command === "candidate") {
    const root = repoRoot(args);
    const cohortPath = path.resolve(
      argumentValue(args, "--cohort", { required: true }),
    );
    const result = buildAndPackReleaseCandidate({
      repoRoot: root,
      outputDirectory: candidateDirectory(args),
      packageNames: loadReleaseCohort(cohortPath),
      version: argumentValue(args, "--version", { required: true }),
      channel: argumentValue(args, "--channel", { required: true }),
      sourceSha: argumentValue(args, "--source-sha", { required: true }),
      expectedCommit: argumentValue(args, "--expected-commit", {
        required: true,
      }),
      build: {
        command: argumentValue(args, "--build-command", { required: true }),
        args: argumentValues(args, "--build-arg"),
      },
      npmCommand: argumentValue(args, "--npm-command") || "npm",
    });
    console.log(
      stableStringify({
        planPath: result.planPath,
        state: result.state.phase,
      }).trim(),
    );
    return result;
  }
  if (command === "verify") {
    const expectedSourceSha = argumentValue(args, "--source-sha");
    const expectedVersion = argumentValue(args, "--version");
    const expectedChannel = argumentValue(args, "--channel");
    const expectedValues = [
      expectedSourceSha,
      expectedVersion,
      expectedChannel,
    ];
    if (
      expectedValues.some((value) => value !== null) &&
      expectedValues.some((value) => value === null)
    ) {
      throw new Error(
        "verify identity requires --source-sha, --version, and --channel together",
      );
    }
    const result = verifyReleaseCandidate({
      repoRoot: repoRoot(args),
      candidateDirectory: candidateDirectory(args),
      expectedIdentity:
        expectedSourceSha === null
          ? undefined
          : {
              sourceSha: expectedSourceSha,
              version: expectedVersion,
              channel: expectedChannel,
            },
    });
    console.log(
      stableStringify({
        planIntegrity: result.planIntegrity,
        phase: result.state.phase,
      }).trim(),
    );
    return result;
  }
  if (command === "inspect") {
    const candidate = candidateDirectory(args);
    verifyReleaseCandidate({
      repoRoot: repoRoot(args),
      candidateDirectory: candidate,
    });
    const { plan } = loadReleasePlan(candidate);
    const records = await inspectReleaseRegistry({
      ...registryOptions(args),
      plan,
    });
    console.log(stableStringify(records).trim());
    return records;
  }
  if (command === "publish") {
    const result = await publishReleaseCandidate({
      repoRoot: repoRoot(args),
      candidateDirectory: candidateDirectory(args),
      ...registryOptions(args),
      npmCommand: argumentValue(args, "--npm-command") || "npm",
    });
    console.log(stableStringify(result).trim());
    return result;
  }
  if (command === "verify-promoted") {
    const result = await verifyPromotedReleaseCandidate({
      repoRoot: repoRoot(args),
      candidateDirectory: candidateDirectory(args),
      ...registryOptions(args),
    });
    console.log(stableStringify(result).trim());
    return result;
  }
  if (command === "push-refs") {
    const result = pushAtomicReleaseRefs({
      repoRoot: repoRoot(args),
      candidateDirectory: candidateDirectory(args),
      remote: argumentValue(args, "--remote", { required: true }),
      branch: argumentValue(args, "--branch", { required: true }),
      tag: argumentValue(args, "--tag", { required: true }),
      expectedOldBranchSha: argumentValue(args, "--expected-old", {
        required: true,
      }),
    });
    console.log(stableStringify(result).trim());
    return result;
  }
  if (command === "push-tag") {
    const result = pushReleaseTag({
      repoRoot: repoRoot(args),
      candidateDirectory: candidateDirectory(args),
      remote: argumentValue(args, "--remote", { required: true }),
      tag: argumentValue(args, "--tag", { required: true }),
    });
    console.log(stableStringify(result).trim());
    return result;
  }
  if (command === "publish-release") {
    const result = await publishGitHubRelease({
      repoRoot: repoRoot(args),
      candidateDirectory: candidateDirectory(args),
      repository: argumentValue(args, "--repository", { required: true }),
      tag: argumentValue(args, "--tag", { required: true }),
      ...githubOptions(args),
    });
    console.log(stableStringify(result).trim());
    return result;
  }
  if (command === "transition") {
    const result = recordReleaseTransition(
      candidateDirectory(args),
      argumentValue(args, "--to", { required: true }),
      readEvidence(
        path.resolve(argumentValue(args, "--evidence", { required: true })),
      ),
    );
    console.log(stableStringify({ phase: result.phase }).trim());
    return result;
  }
  throw new Error(`Unknown release-candidate command ${command}\n\n${usage()}`);
}

const invokedDirectly =
  import.meta.main ||
  (Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    // error-policy:J1 process boundary translates a release failure to exit 1
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
