/**
 * Enforces one immutable CodeQL Action release across every workflow phase.
 * CodeQL persists versioned configuration between initialization and analysis,
 * so mixing otherwise valid action pins makes the later phase fail at runtime.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CODEQL_ACTION_PATTERN =
  /uses:\s*github\/codeql-action\/(init|analyze|upload-sarif)@([^\s#]+)/g;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SETUP_NODE_PATTERN = /uses:\s*actions\/setup-node@([^\s#]+)/;

export function assertCodeqlRuntimeSetup(workflow: string): string {
  const setupNode = workflow.match(SETUP_NODE_PATTERN);
  if (!setupNode) {
    throw new Error(
      "CodeQL workflow must install Node.js before TypeScript extraction",
    );
  }

  const version = setupNode[1];
  if (!COMMIT_SHA_PATTERN.test(version)) {
    throw new Error(
      `CodeQL Node.js setup must use an immutable 40-character commit SHA; received ${version}`,
    );
  }

  const initIndex = workflow.search(/uses:\s*github\/codeql-action\/init@/);
  if (setupNode.index > initIndex) {
    throw new Error("CodeQL workflow must install Node.js before initialization");
  }

  return version;
}

export function assertCodeqlActionVersions(workflow: string): string {
  const phases = [...workflow.matchAll(CODEQL_ACTION_PATTERN)].map((match) => ({
    phase: match[1],
    version: match[2],
  }));

  const requiredPhases = new Set(["init", "analyze"]);
  for (const { phase } of phases) {
    requiredPhases.delete(phase);
  }
  if (requiredPhases.size > 0) {
    throw new Error(
      `CodeQL workflow is missing required phase(s): ${[...requiredPhases].join(", ")}`,
    );
  }

  for (const { phase, version } of phases) {
    if (!COMMIT_SHA_PATTERN.test(version)) {
      throw new Error(
        `CodeQL ${phase} must use an immutable 40-character commit SHA; received ${version}`,
      );
    }
  }

  const versions = new Set(phases.map(({ version }) => version));
  if (versions.size !== 1) {
    const detail = phases
      .map(({ phase, version }) => `${phase}@${version}`)
      .join(", ");
    throw new Error(`CodeQL action phases must use one release: ${detail}`);
  }

  return phases[0].version;
}

if (import.meta.main) {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const workflow = readFileSync(
    `${repositoryRoot}/.github/workflows/codeql.yml`,
    "utf8",
  );
  assertCodeqlRuntimeSetup(workflow);
  const version = assertCodeqlActionVersions(workflow);
  process.stdout.write(`CodeQL action version contract passed (${version}).\n`);
}
