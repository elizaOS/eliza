import { spawnSync } from "node:child_process";
import process from "node:process";

export function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg === name) return "1";
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

export function fail(message) {
  console.error(`[bun-ios-runtime] ${message}`);
  process.exit(1);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding,
    maxBuffer: options.maxBuffer,
  });
  if (options.check !== false && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}`,
    );
  }
  return result;
}

export function runCapture(command, args, options = {}) {
  return run(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
  });
}
