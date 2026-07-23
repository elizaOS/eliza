#!/usr/bin/env node
/**
 * Verifies that an installed elizaOS launcher executes, reports the exact
 * packaged release, and exposes usable Commander help. Package workflows run
 * this process-level check before accepting or publishing an artifact.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

export function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0) {
    throw new Error("Expected `--` before the packaged command");
  }

  const verifierArgs = argv.slice(0, separator);
  let expectedVersion;
  for (let index = 0; index < verifierArgs.length; index += 2) {
    const argument = verifierArgs[index];
    const value = verifierArgs[index + 1];
    if (argument !== "--expected") {
      throw new Error(`Unknown verifier argument: ${String(argument)}`);
    }
    if (expectedVersion !== undefined) {
      throw new Error("--expected may only be provided once");
    }
    if (!value?.trim()) {
      throw new Error("Expected a non-empty --expected version");
    }
    expectedVersion = value.trim();
  }

  const command = argv[separator + 1];
  if (!expectedVersion) {
    throw new Error("Expected a non-empty --expected version");
  }
  if (!command) {
    throw new Error("Expected a packaged command after `--`");
  }

  return {
    command,
    commandArgs: argv.slice(separator + 2),
    expectedVersion,
  };
}

export function runCommand(
  command,
  args,
  { timeoutMs = COMMAND_TIMEOUT_MS } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Command timeout must be a positive integer");
  }

  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    killSignal: "SIGKILL",
    maxBuffer: OUTPUT_LIMIT_BYTES,
    timeout: timeoutMs,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(
        `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
        { cause: result.error },
      );
    }
    throw new Error(`Could not start ${command}: ${result.error.message}`, {
      cause: result.error,
    });
  }

  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) {
    const outcome = result.signal
      ? `terminated by ${result.signal}`
      : `exited ${String(result.status)}`;
    throw new Error(`${command} ${args.join(" ")} ${outcome}\n${output}`);
  }

  // `stdout` is the verified contract value; the combined `output` exists
  // solely for diagnostics, so stderr warnings never corrupt a comparison.
  return { output: output.trim(), stdout: result.stdout.trim() };
}

export function verifyPackagedCli(
  command,
  commandArgs,
  expectedVersion,
  options,
) {
  const versionResult = runCommand(
    command,
    [...commandArgs, "--version"],
    options,
  );
  if (versionResult.stdout !== expectedVersion) {
    const diagnostics =
      versionResult.output === versionResult.stdout
        ? ""
        : `\nCombined output:\n${versionResult.output}`;
    throw new Error(
      `Packaged CLI version mismatch: expected ${expectedVersion}, received ${JSON.stringify(versionResult.stdout)}${diagnostics}`,
    );
  }

  const helpOutput = runCommand(
    command,
    [...commandArgs, "--help"],
    options,
  ).stdout.replaceAll("\r\n", "\n");
  const hasUsage = /(^|\n)Usage:\s*(?:\S[^\n]*|\n[ \t]+\S)/m.test(helpOutput);
  const hasPopulatedSection =
    /(^|\n)(?:Commands|Options):[ \t]*\n[ \t]+\S/m.test(helpOutput);
  if (!hasUsage || !hasPopulatedSection) {
    throw new Error(
      "Packaged CLI help did not contain usable Usage and Commands/Options sections",
    );
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
