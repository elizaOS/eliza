import process from "node:process";
import {
  getLogPrefix,
  RESTART_EXIT_CODE,
  setRestartHandler,
} from "@elizaos/shared";
import {
  formatUncaughtError,
  shouldIgnoreUnhandledRejection,
} from "../runtime/error-handlers";
import { getPrimaryCommand, hasHelpOrVersion } from "./argv";
import { registerSubCliByName } from "./program/register.subclis";

let cliRestartHandlerRegistered = false;

function registerCliRestartHandler(): void {
  if (cliRestartHandlerRegistered) return;
  cliRestartHandlerRegistered = true;
  setRestartHandler((reason) => {
    console.error(
      `${getLogPrefix()} restart requested: ${
        reason ?? "unspecified"
      } — exiting with ${RESTART_EXIT_CODE}`,
    );
    process.exit(RESTART_EXIT_CODE);
  });
}

async function loadDotEnv(): Promise<void> {
  try {
    const { config } = await import("dotenv");
    config({ quiet: true });
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND" &&
      (err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND"
    ) {
      throw err;
    }
  }
}

export async function runCli(argv: string[] = process.argv) {
  registerCliRestartHandler();
  await loadDotEnv();

  // Normalize env: copy Z_AI_API_KEY → ZAI_API_KEY when ZAI_API_KEY is empty.
  if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
    process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
  }
  if (
    !process.env.MOONSHOT_API_KEY?.trim() &&
    process.env.KIMI_API_KEY?.trim()
  ) {
    process.env.MOONSHOT_API_KEY = process.env.KIMI_API_KEY;
  }

  const { buildProgram } = await import("./program");
  const program = buildProgram();

  // Prevent Commander from calling process.exit() directly so that piped stdio (vitest etc)
  // has a chance to flush cleanly before the process spins down.
  program.exitOverride();

  process.on("unhandledRejection", (reason) => {
    if (shouldIgnoreUnhandledRejection(reason)) {
      console.warn(
        `${getLogPrefix()} Provider credits appear exhausted; request failed without output. Top up credits and retry.`,
      );
      return;
    }
    console.error(
      `${getLogPrefix()} Unhandled rejection:`,
      formatUncaughtError(reason),
    );
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    console.error(
      `${getLogPrefix()} Uncaught exception:`,
      formatUncaughtError(error),
    );
    process.exit(1);
  });

  const primary = getPrimaryCommand(argv);
  if (primary && !hasHelpOrVersion(argv)) {
    await registerSubCliByName(program, primary);
  }

  try {
    await program.parseAsync(argv);
  } catch (err) {
    // If commander threw because of an early exit (e.g. --help, --version), don't crash.
    if (err && typeof err === "object" && "code" in err && "exitCode" in err) {
      process.exitCode = (err as { exitCode: number }).exitCode ?? 1;
      return;
    }
    throw err;
  }
}
