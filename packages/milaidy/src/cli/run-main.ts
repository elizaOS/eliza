import process from "node:process";
import { getPrimaryCommand, hasHelpOrVersion } from "./argv.js";

async function loadDotEnv(): Promise<void> {
  try {
    const { config } = await import("dotenv");
    config();
  } catch {
    // dotenv not installed or .env not found
  }
}

function formatUncaughtError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export async function runCli(argv: string[] = process.argv) {
  await loadDotEnv();

  // Normalize env: copy Z_AI_API_KEY → ZAI_API_KEY when ZAI_API_KEY is empty.
  if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
    process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
  }

  const { buildProgram } = await import("./program.js");
  const program = buildProgram();

  process.on("unhandledRejection", (reason) => {
    console.error("[milaidy] Unhandled rejection:", formatUncaughtError(reason));
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    console.error("[milaidy] Uncaught exception:", formatUncaughtError(error));
    process.exit(1);
  });

  const primary = getPrimaryCommand(argv);
  if (primary && !hasHelpOrVersion(argv)) {
    const { registerSubCliByName } = await import("./program/register.subclis.js");
    await registerSubCliByName(program, primary);
  }

  await program.parseAsync(argv);
}
