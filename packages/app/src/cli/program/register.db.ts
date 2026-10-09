/**
 * Registers the `db` CLI command group. `db reset` deletes the local PGlite
 * database directory the runtime would open (resolved by the agent runtime's
 * own resolver, honouring `config.database.pglite.dataDir`, `PGLITE_DATA_DIR`
 * and the configured agent workspace), which is re-created on the next start,
 * after an interactive confirmation prompt unless `--yes` is passed. Runs
 * inside `runCommandWithRuntime` for consistent error/exit handling.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import type { Command } from "commander";
import { runCommandWithRuntime } from "../cli-utils";
import { theme } from "../terminal.js";

const defaultRuntime = {
  error: (message: string) => console.error(message),
  exit: (code: number) => process.exit(code),
};
async function resolveDbDir(): Promise<string> {
  const { loadElizaConfig, resolveActivePgliteDataDir } = await import(
    "@elizaos/agent"
  );
  const dataDir = resolveActivePgliteDataDir(loadElizaConfig());
  if (!dataDir) {
    throw new ElizaError(
      "`eliza db reset` only resets the local PGlite database; the configured database provider is not PGlite",
      { code: "DB_RESET_UNSUPPORTED_PROVIDER" },
    );
  }
  return dataDir;
}
function assertResettableDatabaseDirectory(dataDir: string): void {
  const resolved = fs.realpathSync(dataDir);
  const protectedDirectories = [
    path.parse(resolved).root,
    fs.realpathSync(os.homedir()),
    fs.realpathSync(process.cwd()),
  ];
  if (
    protectedDirectories.includes(resolved) ||
    !fs.lstatSync(dataDir).isDirectory() ||
    !["PG_VERSION", "global/pg_control"].every((marker) => {
      const markerPath = path.join(dataDir, marker);
      return fs.existsSync(markerPath) && fs.lstatSync(markerPath).isFile();
    })
  ) {
    throw new ElizaError(
      `Refusing to reset ${dataDir}: expected a dedicated PGlite directory with database markers`,
      { code: "DB_RESET_UNSAFE_DIRECTORY" },
    );
  }
}

export function registerDbCommand(program: Command) {
  const db = program.command("db").description("Database management");
  db.command("reset")
    .description(
      "Delete the local agent database (will be re-created on next start)",
    )
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { yes: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const dbDir = await resolveDbDir();
        if (!fs.existsSync(dbDir)) {
          console.log(
            `${theme.muted("→")} Database not found at ${dbDir} — nothing to reset.`,
          );
          return;
        }
        if (!opts.yes) {
          if (!process.stdin.isTTY) {
            throw new Error(
              "Database reset requires an interactive terminal or --yes",
            );
          }
          const { createInterface } = await import("node:readline");
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const confirmed = await new Promise<boolean>((resolve) => {
            rl.once("close", () => resolve(false));
            rl.question(
              `${theme.warn("⚠")}  This will delete ${theme.command(dbDir)}.\n   All agent memory and conversation history will be lost.\n   Continue? ${theme.muted("(y/N) ")}`,
              (answer) => {
                resolve(answer.trim().toLowerCase() === "y");
                rl.close();
              },
            );
          });
          if (!confirmed) {
            console.log(`${theme.muted("→")} Cancelled.`);
            return;
          }
        }
        assertResettableDatabaseDirectory(dbDir);
        fs.rmSync(dbDir, { recursive: true, force: true });
        console.log(`${theme.success("✓")} Database deleted: ${dbDir}`);
        console.log(
          `${theme.muted("→")} Run ${theme.command("eliza start")} to initialize a fresh database.`,
        );
      });
    });
}
