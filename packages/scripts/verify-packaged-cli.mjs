#!/usr/bin/env node
/**
 * Verifies that an installed elizaOS application launcher starts, reports the
 * release version being packaged, and exposes usable Commander help. Packaging
 * workflows call this after installation so a broken runtime cannot be hidden
 * behind a successful archive or installer build.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0) {
    throw new Error("Expected `--` before the packaged command");
  }

  const verifierArgs = argv.slice(0, separator);
  const expectedIndex = verifierArgs.indexOf("--expected");
  const expectedVersion = verifierArgs[expectedIndex + 1];
  const command = argv[separator + 1];
  const commandArgs = argv.slice(separator + 2);

  if (expectedIndex < 0 || !expectedVersion?.trim()) {
    throw new Error("Expected a non-empty --expected version");
  }
  if (!command) {
    throw new Error("Expected a packaged command after `--`");
  }

  return { command, commandArgs, expectedVersion: expectedVersion.trim() };
}

export function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Could not start ${command}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}\n${result.stdout}${result.stderr}`,
    );
  }

  return `${result.stdout}${result.stderr}`.trim();
}

export function verifyPackagedCli(command, commandArgs, expectedVersion) {
  const versionOutput = runCommand(command, [...commandArgs, "--version"]);
  if (versionOutput !== expectedVersion) {
    throw new Error(
      `Packaged CLI version mismatch: expected ${expectedVersion}, received ${JSON.stringify(versionOutput)}`,
    );
  }

  const helpOutput = runCommand(command, [...commandArgs, "--help"]);
  if (!/(^|\n)Usage:/m.test(helpOutput)) {
    throw new Error("Packaged CLI help did not contain a Usage section");
  }
  return helpOutput;
}

export function main(argv = process.argv.slice(2)) {
  const { command, commandArgs, expectedVersion } = parseArguments(argv);
  const helpOutput = verifyPackagedCli(command, commandArgs, expectedVersion);
  process.stdout.write(
    `Verified packaged CLI ${expectedVersion}\n${helpOutput}\n`,
  );
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) main();
