#!/usr/bin/env node
/**
 * Verifies that an installed elizaOS launcher reports the exact release,
 * exposes usable help, and can boot its real API from an empty directory.
 * Package workflows run this before any external publication boundary.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_TIMEOUT_MS = 30_000;
const SERVICE_TIMEOUT_MS = 180_000;
const SERVICE_LOG_LIMIT = 4 * 1024 * 1024;

export function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0) {
    throw new Error("Expected `--` before the packaged command");
  }

  const verifierArgs = argv.slice(0, separator);
  const command = argv[separator + 1];
  const commandArgs = argv.slice(separator + 2);
  let expectedVersion;
  let healthUrl;
  let isolationRoot;
  let serviceTimeoutMs = SERVICE_TIMEOUT_MS;
  const serviceArgs = [];

  for (let index = 0; index < verifierArgs.length; index += 2) {
    const argument = verifierArgs[index];
    const value = verifierArgs[index + 1];
    if (!value) {
      throw new Error(`Expected a value after ${String(argument)}`);
    }
    if (argument === "--expected") expectedVersion = value;
    else if (argument === "--health-url") healthUrl = value;
    else if (argument === "--isolation-root") isolationRoot = value;
    else if (argument === "--service-arg") serviceArgs.push(value);
    else if (argument === "--service-timeout-ms") {
      serviceTimeoutMs = Number(value);
      if (!Number.isSafeInteger(serviceTimeoutMs) || serviceTimeoutMs <= 0) {
        throw new Error("--service-timeout-ms must be a positive integer");
      }
    } else {
      throw new Error(`Unknown verifier argument: ${String(argument)}`);
    }
  }

  if (!expectedVersion?.trim()) {
    throw new Error("Expected a non-empty --expected version");
  }
  if (!command) {
    throw new Error("Expected a packaged command after `--`");
  }

  return {
    command,
    commandArgs,
    expectedVersion: expectedVersion.trim(),
    healthUrl,
    isolationRoot,
    serviceArgs,
    serviceTimeoutMs,
  };
}

export function runCommand(
  command,
  args,
  { timeoutMs = COMMAND_TIMEOUT_MS, cwd, env } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
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
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.status)}\n${result.stdout}${result.stderr}`,
    );
  }

  return `${result.stdout}${result.stderr}`.trim();
}

export function resolvePackagedCommand(command, pathValue = process.env.PATH) {
  const candidates = command.includes(path.sep)
    ? [path.resolve(command)]
    : (pathValue ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.resolve(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      // Preserve the final path spelling: snapd and other multiplexer shims
      // dispatch from argv[0], which changes if their symlink is canonicalized.
      return candidate;
    } catch (error) {
      // error-policy:J3 an unavailable candidate remains an explicit miss.
      if (
        error?.code !== "ENOENT" &&
        error?.code !== "ENOTDIR" &&
        error?.code !== "EACCES"
      ) {
        throw error;
      }
    }
  }
  throw new Error(`Could not resolve packaged command: ${command}`);
}

export function verifyPackagedCli(
  command,
  commandArgs,
  expectedVersion,
  { cwd, env } = {},
) {
  const resolvedCommand = resolvePackagedCommand(command);
  if (Boolean(cwd) !== Boolean(env)) {
    throw new TypeError(
      "Packaged CLI verification requires cwd and env together",
    );
  }
  const ownedRoot = cwd || env ? undefined : createIsolationRoot();
  const executionRoot = ownedRoot;
  const executionCwd = cwd ?? prepareIsolatedWorkingDirectory(executionRoot);
  const executionEnvironment =
    env ?? createIsolatedServiceEnvironment(executionRoot);
  try {
    const versionOutput = runCommand(
      resolvedCommand,
      [...commandArgs, "--version"],
      { cwd: executionCwd, env: executionEnvironment },
    );
    if (versionOutput !== expectedVersion) {
      throw new Error(
        `Packaged CLI version mismatch: expected ${expectedVersion}, received ${JSON.stringify(versionOutput)}`,
      );
    }

    const helpOutput = runCommand(resolvedCommand, [...commandArgs, "--help"], {
      cwd: executionCwd,
      env: executionEnvironment,
    });
    if (
      !/(^|\n)Usage:\s*\n\s+\S/m.test(helpOutput) ||
      !/(^|\n)(Commands|Options):\s*\n/m.test(helpOutput)
    ) {
      throw new Error(
        "Packaged CLI help did not contain usable Usage and Commands/Options sections",
      );
    }
    return helpOutput;
  } finally {
    if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
  }
}

function appendLog(current, chunk) {
  return `${current}${chunk.toString()}`.slice(-SERVICE_LOG_LIMIT);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLoopbackHealthUrl(url) {
  return (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    url.port.length > 0
  );
}

function isSettledHealthyRuntime(health, verificationNonce) {
  const phases = health?.deferredBoot?.phases;
  return (
    health?.ready === true &&
    health.runtime === "ok" &&
    health.database === "ok" &&
    health.agentState === "running" &&
    health.plugins?.failed === 0 &&
    health.deferredBoot?.settled === true &&
    health.verificationNonce === verificationNonce &&
    typeof phases === "object" &&
    phases !== null &&
    phases["agent-deferred-boot"] === "complete" &&
    Object.values(phases).every((status) => status === "complete")
  );
}

function settledHealthFailure(health, verificationNonce) {
  if (health?.ready !== true || health.deferredBoot?.settled !== true) {
    return undefined;
  }
  if (health.verificationNonce !== verificationNonce) {
    return "verification nonce does not identify the spawned service";
  }
  if (health.runtime !== "ok") {
    return `runtime=${String(health.runtime)}`;
  }
  if (health.database !== "ok") {
    return `database=${String(health.database)}`;
  }
  if (health.agentState !== "running") {
    return `agentState=${String(health.agentState)}`;
  }
  if (health.plugins?.failed !== 0) {
    return `plugins.failed=${String(health.plugins?.failed)}`;
  }
  const phases = health.deferredBoot?.phases;
  if (typeof phases !== "object" || phases === null) {
    return "deferred phases are missing";
  }
  if (phases["agent-deferred-boot"] !== "complete") {
    return `agent-deferred-boot=${String(phases["agent-deferred-boot"])}`;
  }
  const incompletePhases = Object.entries(phases)
    .filter(([, status]) => status !== "complete")
    .map(([phase, status]) => `${phase}=${String(status)}`);
  if (incompletePhases.length > 0) {
    return `deferred phases incomplete: ${incompletePhases.join(", ")}`;
  }
  return undefined;
}

function createIsolationRoot(candidate) {
  if (!candidate) {
    return realpathSync(
      mkdtempSync(path.join(tmpdir(), "eliza-package-smoke-")),
    );
  }
  const root = realpathSync(path.resolve(candidate));
  const temporaryRoot = realpathSync(tmpdir());
  const relativeRoot = path.relative(temporaryRoot, root);
  if (
    relativeRoot === "" ||
    relativeRoot === ".." ||
    relativeRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeRoot)
  ) {
    throw new Error(
      `Packaged verifier isolation root must be below ${temporaryRoot}: ${root}`,
    );
  }
  return root;
}

function prepareIsolatedWorkingDirectory(root, name = "work") {
  const workingDirectory = path.join(root, name);
  if (
    existsSync(workingDirectory) &&
    readdirSync(workingDirectory).length > 0
  ) {
    throw new Error(
      `Packaged verifier working directory is not empty: ${workingDirectory}`,
    );
  }
  mkdirSync(workingDirectory, { recursive: true });
  return workingDirectory;
}

export function createIsolatedServiceEnvironment(isolationRoot, port) {
  const inherited = {};
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "PATH", "TZ"]) {
    if (process.env[key]) inherited[key] = process.env[key];
  }
  const homeDir = path.join(isolationRoot, "home");
  const stateDir = path.join(isolationRoot, "state");
  const configDir = path.join(isolationRoot, "config");
  const cacheDir = path.join(isolationRoot, "cache");
  const dataDir = path.join(isolationRoot, "data");
  const runtimeDir = path.join(isolationRoot, "runtime");
  const temporaryDir = path.join(isolationRoot, "tmp");
  const toolHome = path.join(isolationRoot, "tool-home");
  for (const directory of [
    homeDir,
    stateDir,
    configDir,
    cacheDir,
    dataDir,
    temporaryDir,
    toolHome,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);

  return {
    ...inherited,
    NO_COLOR: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    ...(port ? { ELIZA_API_PORT: port } : {}),
    HOME: homeDir,
    USER: "eliza-package-smoke",
    LOGNAME: "eliza-package-smoke",
    TMPDIR: temporaryDir,
    ELIZA_HOME: stateDir,
    ELIZA_STATE_DIR: stateDir,
    ELIZA_DATA_DIR: path.join(stateDir, "workspace"),
    ELIZA_DATABASE_DIR: path.join(stateDir, "workspace", ".elizadb"),
    PGLITE_DATA_DIR: path.join(stateDir, "workspace", ".elizadb"),
    ELIZA_CONFIG_PATH: path.join(configDir, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(configDir, "eliza.json"),
    ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS: "1",
    ELIZA_BIRDCLAW: "0",
    ELIZA_GITPATHOLOGIST: "0",
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: configDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_DATA_HOME: dataDir,
    XDG_RUNTIME_DIR: runtimeDir,
    CLAUDE_CONFIG_DIR: path.join(toolHome, "claude"),
    CODEX_HOME: path.join(toolHome, "codex"),
    NPM_CONFIG_USERCONFIG: path.join(configDir, "npmrc"),
    AWS_CONFIG_FILE: path.join(configDir, "aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(configDir, "aws-credentials"),
    DOCKER_CONFIG: path.join(configDir, "docker"),
    KUBECONFIG: path.join(configDir, "kubeconfig"),
    GNUPGHOME: path.join(configDir, "gnupg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function assertHealthPortAvailable(url) {
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  const port = Number(url.port);
  const server = createServer();
  let listening = false;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        listening = true;
        resolve();
      });
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      // error-policy:J2 the occupied port proves the requested health identity
      // is already owned; an unrelated service could otherwise satisfy probes.
      throw new Error(
        `Packaged service health port is already in use: ${url.origin}`,
        { cause: error },
      );
    }
    // error-policy:J2 retain unexpected bind failures at the verifier boundary.
    throw new Error(
      `Could not reserve packaged service health port: ${url.origin}`,
      { cause: error },
    );
  } finally {
    if (listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

async function terminateProcessGroup(child, exitPromise) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    // error-policy:J6 an already-exited process group needs no teardown.
    if (error?.code !== "ESRCH") throw error;
  }
  await Promise.race([exitPromise, sleep(2_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    // error-policy:J6 an already-exited process group needs no teardown.
    if (error?.code !== "ESRCH") throw error;
  }
  await Promise.race([exitPromise, sleep(2_000)]);
}

export async function verifyPackagedService({
  command,
  commandArgs,
  healthUrl,
  serviceArgs,
  timeoutMs = SERVICE_TIMEOUT_MS,
  isolationRoot,
  environment,
}) {
  const url = new URL(healthUrl);
  if (!isLoopbackHealthUrl(url)) {
    throw new Error(
      `Packaged service health URL must be explicit loopback HTTP: ${healthUrl}`,
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Packaged service timeout must be a positive integer");
  }
  await assertHealthPortAvailable(url);

  const resolvedCommand = resolvePackagedCommand(command);
  const verificationNonce = randomUUID();
  const ownsIsolationRoot = !isolationRoot;
  const serviceIsolationRoot = createIsolationRoot(isolationRoot);
  const emptyCwd = prepareIsolatedWorkingDirectory(
    serviceIsolationRoot,
    "service-work",
  );
  let stdout = "";
  let stderr = "";
  let spawnError;
  let exit;
  const child = spawn(resolvedCommand, [...commandArgs, ...serviceArgs], {
    cwd: emptyCwd,
    detached: true,
    env: {
      ...(environment ??
        createIsolatedServiceEnvironment(serviceIsolationRoot, url.port)),
      ELIZA_API_PORT: url.port,
      ELIZA_PACKAGE_SMOKE_NONCE: verificationNonce,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    stdout = appendLog(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendLog(stderr, chunk);
  });
  const exitPromise = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve();
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });

  let lastHealth = "no response";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (spawnError) {
        throw new Error(
          `Could not start packaged service: ${spawnError.message}`,
          {
            cause: spawnError,
          },
        );
      }
      if (exit) {
        throw new Error(
          `Packaged service exited before becoming healthy (${JSON.stringify(exit)})\n${stdout}${stderr}`,
        );
      }

      let response;
      try {
        response = await fetch(url, {
          signal: AbortSignal.timeout(2_000),
        });
      } catch (error) {
        // error-policy:J4 connection refusal is expected while the service binds.
        lastHealth = error instanceof Error ? error.message : String(error);
        await sleep(500);
        continue;
      }

      const body = await response.text();
      lastHealth = `HTTP ${response.status}: ${body}`;
      if (response.ok) {
        let health;
        try {
          health = JSON.parse(body);
        } catch (error) {
          // error-policy:J3 malformed health is retained as an invalid probe.
          lastHealth =
            error instanceof Error
              ? `invalid health JSON: ${error.message}`
              : `invalid health JSON: ${String(error)}`;
          await sleep(500);
          continue;
        }
        if (isSettledHealthyRuntime(health, verificationNonce)) {
          return {
            emptyCwd,
            isolationRoot: serviceIsolationRoot,
            health,
            stderr,
            stdout,
          };
        }
        const failure = settledHealthFailure(health, verificationNonce);
        if (failure) {
          throw new Error(
            `Packaged service settled unhealthy (${failure}): ${body}\n${stdout}${stderr}`,
          );
        }
      }
      await sleep(500);
    }
    throw new Error(
      `Packaged service did not become healthy within ${timeoutMs}ms; last probe: ${lastHealth}\n${stdout}${stderr}`,
    );
  } finally {
    await terminateProcessGroup(child, exitPromise);
    if (ownsIsolationRoot) {
      rmSync(serviceIsolationRoot, { recursive: true, force: true });
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const {
    command,
    commandArgs,
    expectedVersion,
    healthUrl,
    isolationRoot,
    serviceArgs,
    serviceTimeoutMs,
  } = parseArguments(argv);
  const healthPort = healthUrl ? new URL(healthUrl).port : undefined;
  const ownsSharedIsolationRoot = !isolationRoot;
  const sharedIsolationRoot = createIsolationRoot(isolationRoot);
  const environment = createIsolatedServiceEnvironment(
    sharedIsolationRoot,
    healthPort,
  );
  const cliCwd = prepareIsolatedWorkingDirectory(
    sharedIsolationRoot,
    "cli-work",
  );
  try {
    const helpOutput = verifyPackagedCli(
      command,
      commandArgs,
      expectedVersion,
      { cwd: cliCwd, env: environment },
    );
    process.stdout.write(
      `Verified packaged CLI ${expectedVersion}\n${helpOutput}\n`,
    );
    if (healthUrl) {
      const service = await verifyPackagedService({
        command,
        commandArgs,
        healthUrl,
        serviceArgs,
        timeoutMs: serviceTimeoutMs,
        isolationRoot: sharedIsolationRoot,
        environment,
      });
      process.stdout.write(
        `Verified packaged service ${healthUrl}\n${JSON.stringify(service.health)}\n${service.stdout}${service.stderr}`,
      );
    }
  } finally {
    if (ownsSharedIsolationRoot) {
      rmSync(sharedIsolationRoot, { recursive: true, force: true });
    }
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  // error-policy:J1 CLI boundary reports package smoke failures to the job.
  main().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
