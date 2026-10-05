import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";

export class RuntimeLaunchError extends Error {
  constructor(code) {
    super(code);
    this.name = "RuntimeLaunchError";
    this.code = code;
  }
}

export { readPrivateRuntimeJson } from "./private-runtime-json.mjs";

/** Literal private settings only: never expand variables or execute shell text. */
export async function readPrivateRuntimeEnvironment(
  file,
  { optional = false } = {},
) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return {};
    throw error;
  }
  const settings = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new RuntimeLaunchError("INVALID_PRIVATE_ENVIRONMENT");
    settings[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return settings;
}

/** Paths and parent directories must be supplied by the trusted host. */
async function privateFile(file, initial) {
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(typeof initial === "function" ? initial() : initial);
  } catch (error) {
    if (handle) {
      const failures = [error];
      try {
        await handle.close();
      } catch (closeError) {
        failures.push(closeError);
      }
      handle = undefined;
      try {
        await unlink(file);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Private file creation and cleanup failed",
        );
      throw error;
    }
    if (error.code !== "EEXIST") throw error;
  } finally {
    // The creation path also reopens below, so all reads validate the same way.
    await handle?.close();
  }
  handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1)
      throw new RuntimeLaunchError("INVALID_PRIVATE_FILE");
    await handle.chmod(0o600);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Atomic replacement does not follow a pre-existing destination symlink. */
export async function writePrivateRuntimeJson(file, value) {
  const temporary = `${file}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Persistent host profile for runtimes that own updates to their config file. */
export async function preparePrivateRuntimeProfile({
  tokenPath,
  configPath,
  initialConfig,
  createToken = () => randomBytes(48).toString("base64url"),
}) {
  const validateToken = (value) => {
    if (typeof value !== "string")
      throw new RuntimeLaunchError("INVALID_RUNTIME_TOKEN");
    const token = value.trim();
    if (!token || /[\r\n\0]/.test(token))
      throw new RuntimeLaunchError("INVALID_RUNTIME_TOKEN");
    return token;
  };
  const token = validateToken(
    await privateFile(tokenPath, () => validateToken(createToken())),
  );
  const config = JSON.parse(
    await privateFile(configPath, JSON.stringify(initialConfig, null, 2)),
  );
  return { token, config };
}

/** Keep user-authored configuration separate from each selected launch. */
export async function preparePrivateRuntimeFiles({
  tokenPath,
  configPath,
  launchConfigPath,
  initialConfig,
  selectConfig,
  createToken,
}) {
  const { token, config } = await preparePrivateRuntimeProfile({
    tokenPath,
    configPath,
    initialConfig,
    createToken,
  });
  await writePrivateRuntimeJson(launchConfigPath, await selectConfig(config));
  return { token, launchConfigPath };
}

/** Host settings override inherited values; launch-owned values win last. */
export function runtimeEnvironment({
  inherited,
  allow,
  settings,
  owned,
  remove = [],
}) {
  const env = {};
  for (const key of allow) if (inherited[key]) env[key] = inherited[key];
  Object.assign(env, settings, owned);
  for (const key of remove) delete env[key];
  return env;
}

/**
 * One owned child, no restart policy. The caller's existing supervisor owns
 * retries. Attach handlers before any asynchronous receipt work, and reap the
 * child if that work fails. Receipt callbacks must not hang indefinitely.
 */
export async function startPrivateRuntimeProcess({
  command,
  args,
  cwd,
  env,
  stdio = "inherit",
  recordLaunch,
  signalSource = process,
  stopTimeoutMs = 5000,
}) {
  if (
    !Number.isSafeInteger(stopTimeoutMs) ||
    stopTimeoutMs < 1 ||
    stopTimeoutMs > 2_147_483_647
  )
    throw new RuntimeLaunchError("INVALID_STOP_TIMEOUT");
  const child = spawn(command, args, { cwd, env, stdio });
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  let failure = null;
  let finished = false;
  let stopping;
  let cancelled = false;
  const signals = new Map();
  const cleanup = () => {
    for (const [signal, listener] of signals)
      signalSource.removeListener(signal, listener);
  };
  child.on("error", () => {
    failure = new RuntimeLaunchError("RUNTIME_PROCESS_FAILED");
  });
  child.once("close", (code, signal) => {
    finished = true;
    cleanup();
    resolveCompletion({ code, signal, error: failure });
  });
  function stop(signal = "SIGTERM") {
    if (stopping) return stopping;
    stopping = (async () => {
      if (finished) return completion;
      child.kill(signal);
      const timer = setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, stopTimeoutMs);
      try {
        return await completion;
      } finally {
        clearTimeout(timer);
      }
    })();
    return stopping;
  }
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const listener = () => {
      cancelled = true;
      void stop(signal);
    };
    signals.set(signal, listener);
    signalSource.on(signal, listener);
  }
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () =>
        reject(new RuntimeLaunchError("RUNTIME_PROCESS_FAILED")),
      );
    });
    await recordLaunch?.({ pid: child.pid, launchedAt: Date.now() });
    if (cancelled) throw new RuntimeLaunchError("RUNTIME_LAUNCH_CANCELLED");
    if (failure) throw failure;
    return { child, completion, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
