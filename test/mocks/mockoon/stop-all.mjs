#!/usr/bin/env node
/**
 * Kill every Mockoon environment started by `start-all.mjs`.
 *
 * Reads pids from .mockoon-pids/*.pid and sends SIGTERM, then SIGKILL after
 * 2 seconds for any pid still alive.
 */

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const PID_DIR = join(HERE, ".mockoon-pids");

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let pidFiles;
  try {
    pidFiles = readdirSync(PID_DIR).filter((f) => f.endsWith(".pid"));
  } catch {
    console.log("no pid dir; nothing to stop");
    return;
  }

  const pids = pidFiles
    .map((f) => {
      const path = join(PID_DIR, f);
      const pid = Number(readFileSync(path, "utf8").trim());
      return { f, path, pid };
    })
    .filter(({ pid }) => Number.isInteger(pid) && pid > 0);

  for (const { pid, f } of pids) {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`SIGTERM ${f} pid=${pid}`);
      } catch (e) {
        console.warn(`could not SIGTERM ${pid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  await delay(2_000);

  for (const { pid, f, path } of pids) {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
        console.log(`SIGKILL ${f} pid=${pid}`);
      } catch (e) {
        console.warn(`could not SIGKILL ${pid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

main();
