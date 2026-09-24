#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const defaultElizaSourceLockPath = path.join(
  repositoryRoot,
  "release/eliza-source.lock.json",
);

export function readElizaSourceLock(lockPath = defaultElizaSourceLockPath) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const expectedKeys = [
    "commit",
    "commitTimestamp",
    "repository",
    "schemaVersion",
    "sourceRef",
    "submodules",
  ];

  if (
    typeof lock !== "object" ||
    lock === null ||
    Array.isArray(lock) ||
    Object.keys(lock).sort().join("\n") !== expectedKeys.join("\n")
  ) {
    throw new Error(
      `Eliza source lock must contain exactly: ${expectedKeys.join(", ")}`,
    );
  }
  if (lock.schemaVersion !== 1) {
    throw new Error(
      `Unsupported Eliza source lock schema: ${lock.schemaVersion}`,
    );
  }
  if (lock.repository !== "elizaOS/eliza") {
    throw new Error(`Unexpected Eliza source repository: ${lock.repository}`);
  }
  if (!/^[0-9a-f]{40}$/.test(lock.commit)) {
    throw new Error(
      "Eliza source lock commit must be a full lowercase Git SHA",
    );
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(lock.sourceRef)) {
    throw new Error(`Invalid Eliza source ref: ${lock.sourceRef}`);
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(lock.commitTimestamp) ||
    Number.isNaN(Date.parse(lock.commitTimestamp))
  ) {
    throw new Error(
      "Eliza source lock timestamp must be an RFC 3339 UTC timestamp",
    );
  }
  if (lock.submodules !== "recursive") {
    throw new Error("Eliza source lock must require recursive submodules");
  }

  return Object.freeze({ ...lock });
}

function parseArgs(argv) {
  const options = { format: "json", lockPath: defaultElizaSourceLockPath };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--github-output") {
      options.format = "github-output";
    } else if (argument === "--lock") {
      options.lockPath = path.resolve(argv[++index] ?? "");
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const lock = readElizaSourceLock(options.lockPath);
  if (options.format === "github-output") {
    process.stdout.write(
      [
        `repository=${lock.repository}`,
        `commit=${lock.commit}`,
        `source-ref=${lock.sourceRef}`,
        `commit-timestamp=${lock.commitTimestamp}`,
        `submodules=${lock.submodules}`,
        "",
      ].join("\n"),
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(lock)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
