#!/usr/bin/env node
/**
 * Command boundary for immutable npm candidates, registry resume, and atomic
 * release refs. Every side-effecting command requires explicit paths and
 * identities; public npm access additionally requires an opt-in flag.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAndPackReleaseCandidate,
  loadReleasePlan,
  recordReleaseTransition,
  verifyReleaseCandidate,
} from "./lib/release-candidate.mjs";
import { loadReleaseCohort, stableStringify } from "./lib/release-contract.mjs";
import { pushAtomicReleaseRefs } from "./lib/release-git.mjs";
import {
  inspectReleaseRegistry,
  normalizeRegistryUrl,
  publishReleaseCandidate,
} from "./lib/release-registry.mjs";

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
  candidate --cohort <json> --candidate <dir> --version <semver> --channel <tag>
            --source-sha <sha> --expected-commit <sha> --build-command <program>
            [--build-arg <arg> ...] [--npm-command npm] [--repo-root <dir>]
  verify --candidate <dir> [--repo-root <dir>]
  inspect --candidate <dir> --registry <url> [--token-env <name>]
  publish --candidate <dir> --registry <url> [--npm-command npm] [--token-env <name>]
  push-refs --candidate <dir> --remote <name-or-url> --branch <name> --tag <tag>
            --expected-old <sha> [--repo-root <dir>]
  transition --candidate <dir> --to <phase> --evidence <json-file>

Public registry inspection or mutation additionally requires --allow-public-registry.`;
}

export async function main(args = process.argv.slice(2)) {
  const [command] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return null;
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
    const result = verifyReleaseCandidate({
      repoRoot: repoRoot(args),
      candidateDirectory: candidateDirectory(args),
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
