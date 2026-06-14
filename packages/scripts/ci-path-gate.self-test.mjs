#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("./ci-path-gate.mjs", import.meta.url).pathname;

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

console.log("ci-path-gate self-test passed");
