/**
 * Registers the `db` CLI command group. `db reset` deletes the local PGlite
 * database directory the runtime would open (resolved by the agent runtime's
 * own resolver, honouring `config.database.pglite.dataDir`, `PGLITE_DATA_DIR`
 * and the configured agent workspace), which is re-created on the next start,
 * after an interactive confirmation prompt unless `--yes` is passed. Runs
 * inside `runCommandWithRuntime` for consistent error/exit handling.
 */
import fs from "node:fs";
import { ElizaError } from "@elizaos/core";
import type { Command } from "commander";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils";

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
        fs.rmSync(dbDir, { recursive: true, force: true });
        console.log(`${theme.success("✓")} Database deleted: ${dbDir}`);
        console.log(
          `${theme.muted("→")} Run ${theme.command("eliza start")} to initialize a fresh database.`,
        );
      });
    });
}
