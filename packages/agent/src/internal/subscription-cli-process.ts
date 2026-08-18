/**
 * Resolves and launches the npm-installed subscription CLIs across platforms.
 * Windows uses real executable boundaries for npm and PATHEXT-aware probes.
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SubscriptionCliProcessOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface SubscriptionCliNpmInvocation {
  args: string[];
  command: string;
}

interface RunSubscriptionCliNpmOptions extends SubscriptionCliProcessOptions {
  execute?: (
    command: string,
    args: string[],
    options: { timeout: number },
  ) => Promise<unknown>;
  timeout: number;
}

function isFile(filePath: string): boolean {
  return statSync(filePath, { throwIfNoEntry: false })?.isFile() === true;
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH ?? env.Path ?? "";
  return pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter(Boolean);
}

function uniquePathEntries(
  entries: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolve a CLI on PATH using the executable suffixes Windows actually runs.
 * npm writes device-login shims as `.cmd`, so treating the extensionless
 * companion file as executable would make the later child process fail.
 */
export function subscriptionCliCommandAvailable(
  command: string,
  options: SubscriptionCliProcessOptions = {},
): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const names =
    platform === "win32" && path.extname(command) === ""
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim().toLowerCase())
          .filter(Boolean)
          .map((extension) => `${command}${extension}`)
      : [command];

  return pathEntries(env).some((directory) =>
    names.some((name) => isFile(path.join(directory, name))),
  );
}

/**
 * Resolve npm without routing the user-controlled state-directory prefix
 * through a command shell. Standard Windows Node installations keep
 * `node.exe`, `npm.cmd`, and `node_modules/npm/bin/npm-cli.js` together; call
 * the JavaScript entrypoint through Node so spaces and shell metacharacters in
 * the prefix remain ordinary argv data.
 */
export function resolveSubscriptionCliNpmInvocation(
  args: string[],
  options: SubscriptionCliProcessOptions = {},
): SubscriptionCliNpmInvocation {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command: "npm", args };
  }

  const candidateDirectories = uniquePathEntries(pathEntries(env), platform);

  for (const directory of candidateDirectories) {
    const nodeExecutable = path.join(directory, "node.exe");
    const npmCli = path.join(
      directory,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (isFile(nodeExecutable) && isFile(npmCli)) {
      return { command: nodeExecutable, args: [npmCli, ...args] };
    }
  }

  throw new Error(
    "No complete Windows Node.js/npm installation was found on PATH",
  );
}

export async function runSubscriptionCliNpm(
  args: string[],
  options: RunSubscriptionCliNpmOptions,
): Promise<unknown> {
  const invocation = resolveSubscriptionCliNpmInvocation(args, options);
  const execute =
    options.execute ??
    ((command, commandArgs, execOptions) =>
      execFileAsync(command, commandArgs, execOptions));
  return execute(invocation.command, invocation.args, {
    timeout: options.timeout,
  });
}
