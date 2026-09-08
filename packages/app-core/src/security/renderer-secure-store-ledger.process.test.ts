/** Exercises actual Node/Bun processes and SQLite crash locking with an isolated file-backed credential test double; not real keychain/device acceptance. */
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./renderer-secure-store-ledger.process-fixture.ts", import.meta.url),
);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const args = (runtime: string) =>
  runtime === "bun" ? [fixture] : ["--import", "tsx", fixture];
const executable = (runtime: string) =>
  runtime === "bun" ? "bun" : process.execPath;
async function run(runtime: string, directory: string, mode: string) {
  const { stdout } = await execute(
    executable(runtime),
    [...args(runtime), directory, mode],
    { timeout: 20_000 },
  );
  return JSON.parse(stdout.trim());
}
async function waitFile(path: string) {
  const deadline = performance.now() + 10_000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline)
      throw new Error("Isolated child did not settle");
    await delay(10);
  }
}

describe("native ledger process lifetime", () => {
  it.each([
    ["node", "payload"],
    ["bun", "payload"],
    ["node", "migration"],
    ["bun", "migration"],
  ])(
    "keeps the newer %s value after a killed owner leaves an orphan %s writer",
    async (runtime, phase) => {
      const directory = mkdtempSync(
        join(tmpdir(), "eliza-native-process-test-"),
      );
      directories.push(directory);
      expect(
        await run(
          runtime,
          directory,
          phase === "migration" ? "seed" : "initialize",
        ),
      ).toMatchObject({
        value: "fixture-original",
        runtime,
      });
      const owner = spawn(
        executable(runtime),
        [
          ...args(runtime),
          directory,
          phase === "migration" ? "orphan-migration-owner" : "orphan-owner",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      let errors = "";
      owner.stdout.setEncoding("utf8");
      owner.stderr.setEncoding("utf8");
      owner.stdout.on("data", (chunk) => {
        output += chunk;
      });
      owner.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      try {
        const deadline = performance.now() + 15_000;
        while (!output.includes('"ready":true')) {
          if (owner.exitCode !== null || performance.now() >= deadline)
            throw new Error(`Fixture owner unavailable: ${errors}`);
          await delay(10);
        }
        const exited = once(owner, "exit");
        owner.kill("SIGKILL");
        await exited;
        const before = readdirSync(join(directory, "protected-fixture")).length;
        // Exercise the other runtime against the very same durable SQLite ledger.
        const contender = runtime === "node" ? "bun" : "node";
        expect(await run(contender, directory, "write")).toMatchObject({
          value: "fixture-newer-winner",
        });
        writeFileSync(join(directory, "release-orphan-fixture"), "release", {
          mode: 0o600,
        });
        await waitFile(join(directory, "orphan-finished-fixture"));
        expect(readdirSync(join(directory, "protected-fixture")).length).toBe(
          before + 2,
        );
        expect(await run(runtime, directory, "read")).toMatchObject({
          value: "fixture-newer-winner",
        });
        expect(
          readFileSync(
            join(directory, "renderer-native-authority", "authority.sqlite"),
          ).includes(Buffer.from("fixture-newer-winner")),
        ).toBe(false);
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) {
          const exited = once(owner, "exit");
          owner.kill("SIGKILL");
          await exited;
        }
        if (existsSync(join(directory, "orphan-ready-fixture"))) {
          writeFileSync(join(directory, "release-orphan-fixture"), "release", {
            mode: 0o600,
          });
          await waitFile(join(directory, "orphan-finished-fixture"));
        }
      }
    },
    45_000,
  );
});
