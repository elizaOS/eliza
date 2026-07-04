// Exercises tests build agent image workflow.test automation behavior with deterministic script fixtures.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowText = readFileSync(
  new URL("../../../.github/workflows/build-agent-image.yml", import.meta.url),
  "utf8",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractStepRunBlock(stepName: string): string {
  const stepPattern = new RegExp(
    `^      - name: ${escapeRegExp(stepName)}\\n(?<body>[\\s\\S]*?)(?=^      - (?:name|uses|id): |$(?![\\s\\S]))`,
    "m",
  );
  const stepMatch = workflowText.match(stepPattern);
  if (!stepMatch?.groups?.body) {
    throw new Error(`Missing workflow step: ${stepName}`);
  }

  const runMatch = stepMatch.groups.body.match(
    /^ {8}run: \|\n(?<run>(?: {10}.*(?:\n|$))*)/m,
  );
  if (!runMatch?.groups?.run) {
    throw new Error(`Workflow step has no shell run block: ${stepName}`);
  }

  return runMatch.groups.run
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
    .trim();
}

function workflowStepNames(): string[] {
  return [...workflowText.matchAll(/^ {6}- name: (.+)$/gm)].map(
    (match) => match[1],
  );
}

function extractTurboFilters(runBlock: string): string[] {
  return [...runBlock.matchAll(/--filter=(?:'([^']+)'|"([^"]+)"|([^\\\s]+))/g)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .sort();
}

describe("build-agent-image workflow", () => {
  test("uses Turbo filters for Docker workspace artifact builds", () => {
    const runBlock = extractStepRunBlock("Build Docker workspace artifacts");

    expect(runBlock).toContain("node packages/scripts/run-turbo.mjs run build");
    expect(runBlock).toContain("--concurrency=8");
    expect(runBlock).not.toMatch(
      // Reject a bare package-manager `build` (the shell loop we migrated off),
      // but allow legitimately-named scripts like `build:foo` (the `:` guard).
      /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build(?![\w:])/,
    );
    expect(runBlock).not.toMatch(/\bfor\s+\w+\s+in\s+(?:packages|plugins)\b/);
    expect(runBlock).not.toMatch(/\bwhile\s+read\b/);

    expect(extractTurboFilters(runBlock)).toEqual([
      "@elizaos/agent",
      "@elizaos/app",
      "@elizaos/plugin-agent-skills",
      "@elizaos/plugin-browser",
      "@elizaos/plugin-capacitor-bridge",
      "@elizaos/plugin-coding-tools",
      "@elizaos/plugin-commands",
      "@elizaos/plugin-computeruse",
      "@elizaos/plugin-discord",
      "@elizaos/plugin-edge-tts",
      "@elizaos/plugin-elizacloud",
      "@elizaos/plugin-imessage",
      "@elizaos/plugin-local-inference",
      "@elizaos/plugin-mcp",
      "@elizaos/plugin-native-filesystem",
      "@elizaos/plugin-pdf",
      "@elizaos/plugin-shell",
      "@elizaos/plugin-signal",
      "@elizaos/plugin-sql",
      "@elizaos/plugin-streaming",
      "@elizaos/plugin-telegram",
      "@elizaos/plugin-video",
      "@elizaos/plugin-wallet",
      "@elizaos/plugin-whatsapp",
      "@elizaos/plugin-workflow",
      "@elizaos/plugin-x402",
    ]);
  });

  test("keeps Node ESM dist rewrite after the Turbo build", () => {
    const steps = workflowStepNames();
    const buildIndex = steps.indexOf("Build Docker workspace artifacts");
    const rewriteIndex = steps.indexOf("Normalize plugin dist for Node ESM");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(rewriteIndex).toBeGreaterThan(buildIndex);

    const runBlock = extractStepRunBlock("Normalize plugin dist for Node ESM");
    expect(runBlock).toContain("for dist in plugins/*/dist");
    expect(runBlock).toContain(
      "packages/scripts/rewrite-dist-relative-imports-node-esm.mjs",
    );
    expect(runBlock).not.toMatch(
      // Reject a bare package-manager `build` (the shell loop we migrated off),
      // but allow legitimately-named scripts like `build:foo` (the `:` guard).
      /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build(?![\w:])/,
    );
  });
});
