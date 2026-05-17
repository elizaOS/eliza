import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";
import { theme } from "@elizaos/shared";
import type { Command } from "commander";
import { runCommandWithRuntime } from "../cli-utils";

const defaultRuntime = { error: console.error, exit: process.exit };

function resolveDbDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "workspace", ".eliza", ".elizadb");
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
        const dbDir = resolveDbDir();

        if (!fs.existsSync(dbDir)) {
          console.log(
            `${theme.muted("→")} Database not found at ${dbDir} — nothing to reset.`,
          );
          return;
        }

        if (!opts.yes) {
          const { createInterface } = await import("node:readline");
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const confirmed = await new Promise<boolean>((resolve) => {
            rl.question(
              `${theme.warn("⚠")}  This will delete ${theme.command(dbDir)}.\n   All agent memory and conversation history will be lost.\n   Continue? ${theme.muted("(y/N) ")}`,
              (answer) => {
                rl.close();
                resolve(answer.trim().toLowerCase() === "y");
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
