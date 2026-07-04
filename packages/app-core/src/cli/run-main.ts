/**
 * `runCli()` — the CLI process entrypoint. Installs the restart handler, loads
 * `.env`, normalizes provider key aliases (Z_AI_API_KEY→ZAI_API_KEY,
 * KIMI_API_KEY→MOONSHOT_API_KEY), builds the Commander program, eagerly loads
 * the primary sub-CLI when one is named, then parses argv. Also owns the global
 * error handlers: long-running server commands (`start`/`serve`) install crash
 * guards that keep the process alive on background rejections and hand uncaught
 * exceptions to the supervisor for restart, while one-shot commands fail fast;
 * tests opt out so a rejection still fails the test.
 */
import process from "node:process";
import {
  getLogPrefix,
  installProcessCrashGuards,
  RESTART_EXIT_CODE,
  setRestartHandler,
} from "@elizaos/shared";
import {
  formatUncaughtError,
  shouldIgnoreUnhandledRejection,
} from "../runtime/error-handlers";
import { getPrimaryCommand, hasHelpOrVersion } from "./argv";
import { registerSubCliByName } from "./program/register.subclis";

/** Commands that boot a long-running server we must keep alive across faults. */
const LONG_RUNNING_COMMANDS = new Set(["start", "serve"]);

function isLongRunningServerCommand(argv: string[]): boolean {
  const primary = getPrimaryCommand(argv);
  return primary != null && LONG_RUNNING_COMMANDS.has(primary);
}

/**
 * Install the global crash handlers.
 *
 * For a long-running server (`start` / `serve`) a background promise rejection
 * must never take down the agent, and an uncaught exception should hand off to
 * the supervisor for a clean restart — so we use {@link installProcessCrashGuards}.
 * One-shot CLI commands keep the strict "fail the command" behavior. Tests opt
 * out entirely so a rejection still fails the test.
 */
function installGlobalErrorHandlers(argv: string[]): void {
  if (process.env.NODE_ENV === "test") return;

  if (isLongRunningServerCommand(argv)) {
    installProcessCrashGuards({
      logPrefix: getLogPrefix(),
      isIgnorable: shouldIgnoreUnhandledRejection,
      onUncaughtException: "restart",
    });
    return;
  }

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
}

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

  installGlobalErrorHandlers(argv);

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
