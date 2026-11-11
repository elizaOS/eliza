#!/usr/bin/env bun
/**
 * cloud-deploy: render a product's Cloud configuration (API Worker, login,
 * speech and admission Workers, Pages front end) from its deployment file,
 * and check that a rendered configuration bundles.
 *
 *   render --deployment <file> --environment <staging|production>
 *          --upstream <repo root> --out <dir>
 *          [--component <api|login|speech|admission|web|all>]
 *   check  --config <rendered file> [--wrangler <bin>] [--keep <dir>]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkRenderedConfig } from "./check";
import { RenderError } from "./render";
import { definedComponents, renderComponent } from "./render-components";
import {
  DEPLOYMENT_COMPONENTS,
  DEPLOYMENT_ENVIRONMENTS,
  type DeploymentComponentName,
  type DeploymentEnvironmentName,
  DeploymentFileError,
  validateDeployment,
} from "./schema";

const USAGE = `Usage:
  cloud-deploy render --deployment <file> --environment <staging|production> --upstream <repo root> --out <dir> [--component <${DEPLOYMENT_COMPONENTS.join("|")}|all>]
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
    "component",
  ]);
  const deploymentFile = resolve(required(flags, "deployment"));
  const environment = required(flags, "environment");
  if (!(DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new UsageError(
      `--environment must be one of ${DEPLOYMENT_ENVIRONMENTS.join(", ")}`,
    );
  }
  const component = flags.component ?? "api";
  if (
    component !== "all" &&
    !(DEPLOYMENT_COMPONENTS as readonly string[]).includes(component)
  ) {
    throw new UsageError(
      `--component must be one of ${DEPLOYMENT_COMPONENTS.join(", ")}, all`,
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
  const deployment = validateDeployment(parsed);
  const env = deployment.environments[environment as DeploymentEnvironmentName];
  const components =
    component === "all" && env
      ? definedComponents(env)
      : [(component === "all" ? "api" : component) as DeploymentComponentName];
  // Render everything before writing anything: a refused component leaves
  // the output directory as it was.
  const rendered = components.map((name) =>
    renderComponent({
      deployment,
      environment: environment as DeploymentEnvironmentName,
      upstreamRoot,
      outDir,
      component: name,
    }),
  );

  mkdirSync(outDir, { recursive: true });
  for (const entry of rendered) {
    const configFile = join(outDir, entry.fileName);
    const secretsFile = join(outDir, entry.secretsFileName);
    writeFileSync(configFile, entry.text);
    writeFileSync(secretsFile, entry.secretsText);
    console.log(`wrote ${configFile}`);
    console.log(`wrote ${secretsFile}`);
  }
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
        kind: result.kind,
        ok: result.ok,
        notValidated: result.notValidated,
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
