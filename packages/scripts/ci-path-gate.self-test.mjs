#!/usr/bin/env node
// Exercises ci path gate.self test automation behavior with deterministic script fixtures.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./ci-path-gate.mjs", import.meta.url));

function runGate({ config, files = [], labels = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "ci-path-gate-"));
  const changedFiles = join(dir, "changed-files.txt");
  const output = join(dir, "github-output.txt");
  const summary = join(dir, "summary.md");
  writeFileSync(changedFiles, `${files.join("\n")}\n`);

  const result = spawnSync(
    process.execPath,
    [
      script,
      "--config",
      config,
      "--event",
      "pull_request",
      "--changed-files",
      changedFiles,
      "--labels",
      labels,
      "--output",
      output,
      "--summary",
      summary,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `ci-path-gate exited ${result.status}`,
    );
  }

  const values = Object.fromEntries(
    readOutput(output).map((line) => {
      const [key, value] = line.split("=");
      return [key, value];
    }),
  );
  rmSync(dir, { recursive: true, force: true });
  return values;
}

function readOutput(path) {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertGate(name, actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assertEqual(actual[key], value, `${name} ${key}`);
  }
}

assertGate(
  "app changes",
  runGate({ config: "test", files: ["packages/app/src/App.tsx"] }),
  {
    server: "false",
    client: "true",
    plugins: "false",
    desktop: "false",
    zero_key: "true",
    cloud: "false",
  },
);

assertGate(
  "tui library changes",
  runGate({ config: "test", files: ["packages/tui/src/terminal.ts"] }),
  {
    server: "true",
    client: "true",
    plugins: "true",
    desktop: "false",
    zero_key: "true",
    cloud: "false",
  },
);

assertGate("full label", runGate({ config: "test", labels: "ci:full" }), {
  server: "true",
  client: "true",
  plugins: "true",
  desktop: "true",
  zero_key: "true",
  cloud: "true",
});

assertGate(
  "android label",
  runGate({ config: "mobile", labels: "ci:android" }),
  {
    ios: "false",
    android: "true",
  },
);

assertGate(
  "docker runtime",
  runGate({ config: "docker", files: ["plugins/plugin-openai/src/index.ts"] }),
  {
    docker: "true",
  },
);

// The elizaos CLI suite runs under `test:server`; a CLI-only PR must trigger the
// server lane (it previously matched no rule and skipped every test lane).
assertGate(
  "elizaos CLI changes",
  runGate({ config: "test", files: ["packages/elizaos/src/scaffold.ts"] }),
  {
    server: "true",
    client: "false",
    plugins: "false",
    desktop: "false",
    zero_key: "false",
    cloud: "false",
  },
);

// Runtime skills also run under `test:server`.
assertGate(
  "runtime skills changes",
  runGate({ config: "test", files: ["packages/skills/src/index.ts"] }),
  {
    server: "true",
    client: "false",
  },
);

// Fail-safe: a novel/unmapped code package must never skip every lane. It routes
// to the server lane rather than passing green with zero tests.
assertGate(
  "unmapped code path fail-safe",
  runGate({ config: "test", files: ["packages/inference/src/router.ts"] }),
  {
    server: "true",
    client: "false",
    plugins: "false",
    desktop: "false",
    zero_key: "false",
    cloud: "false",
  },
);

// A second unmapped package proves the fail-safe branch, not a one-off pattern.
assertGate(
  "unmapped registry package fail-safe",
  runGate({ config: "test", files: ["packages/registry/src/index.ts"] }),
  {
    server: "true",
  },
);

// Pure docs/marketing surfaces are exempt and still skip cleanly (no fail-safe).
assertGate(
  "docs-only changes skip cleanly",
  runGate({ config: "test", files: ["packages/docs/pages/intro.mdx"] }),
  {
    server: "false",
    client: "false",
    plugins: "false",
    desktop: "false",
    zero_key: "false",
    cloud: "false",
  },
);

// Non-code changes (top-level files) are outside the code roots - no fail-safe.
assertGate(
  "top-level non-code changes skip cleanly",
  runGate({ config: "test", files: ["README.md"] }),
  {
    server: "false",
    client: "false",
    plugins: "false",
    desktop: "false",
    zero_key: "false",
    cloud: "false",
  },
);

// An ignored docs path alongside a real orphan code path still trips the
// fail-safe - the orphan is what matters.
assertGate(
  "mixed docs + orphan code trips fail-safe",
  runGate({
    config: "test",
    files: ["packages/docs/pages/x.mdx", "packages/inference/src/y.ts"],
  }),
  {
    server: "true",
  },
);

console.log("ci-path-gate self-test passed");
