#!/usr/bin/env node
/**
 * Waits for the detached CI Bun-release server to publish its loopback URL.
 * Loaded shared runners may take several seconds to schedule the child; the
 * wait remains bounded and fails immediately if that child exits.
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

function parsePositiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

export function validateLocalBunReleaseUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !/^[1-9][0-9]*$/.test(url.port) ||
    url.pathname !== "/bun.zip" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Bun release server published an invalid loopback URL");
  }
  return url.toString();
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForBunReleaseServer(
  {
    pid,
    urlFile,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  },
  {
    exists = existsSync,
    read = (path) => readFileSync(path, "utf8"),
    isAlive = processIsAlive,
    now = Date.now,
    sleep = (durationMs) =>
      new Promise((resolve) => setTimeout(resolve, durationMs)),
  } = {},
) {
  const startedAt = now();
  while (true) {
    if (!isAlive(pid)) {
      throw new Error("Bun release server exited before publishing its URL");
    }

    if (exists(urlFile)) {
      const value = read(urlFile).trim();
      if (value !== "") {
        const url = validateLocalBunReleaseUrl(value);
        if (!isAlive(pid)) {
          throw new Error("Bun release server exited after publishing its URL");
        }
        return url;
      }
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `Bun release server did not become ready within ${timeoutMs}ms`,
      );
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--pid") {
      options.pid = parsePositiveInteger(argv[++index], "--pid");
    } else if (token === "--url-file") {
      options.urlFile = argv[++index];
    } else if (token === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(argv[++index], "--timeout-ms");
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!options.pid) throw new Error("--pid is required");
  if (!options.urlFile) throw new Error("--url-file is required");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const url = await waitForBunReleaseServer(parseArgs(argv));
  process.stdout.write(`${url}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // error-policy:J1 the executable boundary reports one actionable failure
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
