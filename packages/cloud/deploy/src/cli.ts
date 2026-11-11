#!/usr/bin/env bun
/**
 * cloud-deploy: render a product's Cloud API Worker configuration from its
 * deployment file, and check that the rendered configuration bundles.
 *
 *   render --deployment <file> --environment <staging|production>
 *          --upstream <repo root> --out <dir>
 *   check  --config <rendered file> [--wrangler <bin>] [--keep <dir>]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkRenderedConfig } from "./check";
import { RenderError, renderWranglerConfig } from "./render";
import {
  DEPLOYMENT_ENVIRONMENTS,
  type DeploymentEnvironmentName,
  DeploymentFileError,
  validateDeployment,
} from "./schema";

const USAGE = `Usage:
  cloud-deploy render --deployment <file> --environment <staging|production> --upstream <repo root> --out <dir>
  cloud-deploy check --config <rendered file> [--wrangler <bin>] [--keep <dir>]`;

class UsageError extends Error {}

function parseFlags(
  args: readonly string[],
  known: readonly string[],
): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!known.includes(name)) throw new UsageError(`unknown argument ${flag}`);
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    if (name in flags) throw new UsageError(`${flag} given twice`);
    flags[name] = value;
  }
  return flags;
}

function required(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new UsageError(`--${name} is required`);
  return value;
}

function render(args: readonly string[]): number {
  const flags = parseFlags(args, [
    "deployment",
    "environment",
    "upstream",
    "out",
  ]);
  const deploymentFile = resolve(required(flags, "deployment"));
  const environment = required(flags, "environment");
  if (!(DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new UsageError(
      `--environment must be one of ${DEPLOYMENT_ENVIRONMENTS.join(", ")}`,
    );
  }
  const upstreamRoot = resolve(required(flags, "upstream"));
  const outDir = resolve(required(flags, "out"));

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(deploymentFile, "utf8"));
  } catch (error) {
    throw new UsageError(
      `cannot read ${deploymentFile}: ${(error as Error).message}`,
    );
  }
  const rendered = renderWranglerConfig({
    deployment: validateDeployment(parsed),
    environment: environment as DeploymentEnvironmentName,
    upstreamRoot,
    outDir,
  });

  mkdirSync(outDir, { recursive: true });
  const configFile = join(outDir, rendered.fileName);
  const secretsFile = join(outDir, rendered.secretsFileName);
  writeFileSync(configFile, rendered.text);
  writeFileSync(secretsFile, rendered.secretsText);
  console.log(`wrote ${configFile}`);
  console.log(`wrote ${secretsFile}`);
  return 0;
}

function check(args: readonly string[]): number {
  const flags = parseFlags(args, ["config", "wrangler", "keep"]);
  const result = checkRenderedConfig({
    configFile: required(flags, "config"),
    wrangler: flags.wrangler,
    keepDir: flags.keep,
  });
  if (!result.ok) console.error(result.output);
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        exitCode: result.exitCode,
        wrangler: result.wrangler,
        entry: result.entry,
        bundleBytes: result.bundleBytes,
        totalUpload: result.totalUpload,
        files: result.files,
        outDir: result.outDir,
      },
      null,
      2,
    ),
  );
  return result.ok ? 0 : 1;
}

function main(argv: readonly string[]): number {
  const [command, ...args] = argv;
  try {
    if (command === "render") return render(args);
    if (command === "check") return check(args);
    throw new UsageError(
      command ? `unknown command ${command}` : "a command is required",
    );
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof DeploymentFileError || error instanceof RenderError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

process.exit(main(process.argv.slice(2)));
