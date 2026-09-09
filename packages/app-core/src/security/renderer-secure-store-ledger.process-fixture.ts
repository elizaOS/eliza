/** Runs isolated process/crash ledger regressions using files as the protected-store test double; never accesses the OS credential store. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { PlatformSecureStore } from "./platform-secure-store";
import { RendererSecureStoreLedger } from "./renderer-secure-store-ledger";
import { RendererSecureStoreTransactions } from "./renderer-secure-store-transactions";

const [directory, mode, payloadId, payloadKey, payloadValue] =
  process.argv.slice(2);
if (!directory || !mode) throw new Error("Isolated fixture arguments required");
const vault = "isolated-process-ledger";
const slot = "runtime.active_server";
const protectedDirectory = join(directory, "protected-fixture");
mkdirSync(protectedDirectory, { recursive: true, mode: 0o700 });
const file = (id: string, key: string) =>
  join(
    protectedDirectory,
    createHash("sha256")
      .update(JSON.stringify([id, key]))
      .digest("hex"),
  );
const release = join(directory, "release-orphan-fixture");
const ready = join(directory, "orphan-ready-fixture");
const finished = join(directory, "orphan-finished-fixture");
async function waitFile(path: string): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline)
      throw new Error("Isolated fixture rendezvous timed out");
    await delay(10);
  }
}

if (mode === "orphan-payload") {
  if (!payloadId || !payloadKey || !payloadValue)
    throw new Error("Missing isolated payload");
  writeFileSync(ready, "ready", { mode: 0o600 });
  await waitFile(release);
  writeFileSync(file(payloadId, payloadKey), payloadValue, {
    flag: payloadId.endsWith(":renderer-ledger-anchor") ? "w" : "wx",
    mode: 0o600,
  });
  writeFileSync(finished, "finished", { mode: 0o600 });
} else {
  let orphanSpawned = false;
  const native: Pick<PlatformSecureStore, "get" | "set"> = {
    get: async (id, key) => {
      const path = file(id, key);
      return existsSync(path)
        ? { ok: true, value: readFileSync(path, "utf8") }
        : { ok: false, reason: "not_found" };
    },
    set: async (id, key, value) => {
      if (
        !orphanSpawned &&
        ((mode === "orphan-owner" && id.includes(":renderer-payload:")) ||
          (mode === "orphan-migration-owner" &&
            id.endsWith(":renderer-ledger-anchor")))
      ) {
        orphanSpawned = true;
        const fixture = fileURLToPath(import.meta.url);
        const args = process.versions.bun
          ? [fixture]
          : ["--import", "tsx", fixture];
        const child = spawn(
          process.execPath,
          [...args, directory, "orphan-payload", id, key, value],
          { stdio: "ignore", detached: true },
        );
        child.unref();
        await waitFile(ready);
        process.stdout.write(
          `${JSON.stringify({ ready: true, childPid: child.pid })}\n`,
        );
        await waitFile(finished);
        return { ok: true };
      }
      writeFileSync(file(id, key), value, { flag: "wx", mode: 0o600 });
      return { ok: true };
    },
  };
  const ledger = new RendererSecureStoreLedger(directory, native);
  const protocol = new RendererSecureStoreTransactions(ledger.store, ledger);
  if (mode === "initialize" || mode === "seed") {
    writeFileSync(file(vault, slot), "fixture-original", { mode: 0o600 });
    if (mode === "initialize") await ledger.migrateLegacy(vault);
  } else if (mode === "write") {
    await ledger.migrateLegacy(vault);
    await protocol.write(vault, slot, "fixture-newer-winner");
  } else if (mode === "orphan-owner") {
    await protocol.write(vault, slot, "fixture-stale-orphan");
  } else if (mode === "orphan-migration-owner") {
    await ledger.migrateLegacy(vault);
  } else if (mode !== "read") throw new Error("Unknown isolated fixture mode");
  process.stdout.write(
    `${JSON.stringify({ value: mode === "seed" ? "fixture-original" : (await protocol.read(vault, slot)).value, runtime: process.versions.bun ? "bun" : "node" })}\n`,
  );
}
