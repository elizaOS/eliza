import path from "node:path";
import { logger } from "@elizaos/core";
import { shouldUseSandboxExecution } from "../runtime/local-execution-mode.ts";
import type { SandboxManager } from "../services/sandbox-manager.ts";

export interface TerminalExecutionRoute {
  route: "host" | "sandbox";
  sandboxManager: SandboxManager | null;
  error?: string;
}

export function resolveTerminalExecutionRoute(args: {
  runtime?: { getSetting?: (key: string) => unknown } | null;
  sandboxManager: SandboxManager | null;
}): TerminalExecutionRoute {
  if (!shouldUseSandboxExecution(args.runtime)) {
    return { route: "host", sandboxManager: null };
  }
  if (!args.sandboxManager) {
    const error =
      "local-safe mode requires SandboxManager, but no sandbox manager is available for terminal execution.";
    logger.error(`[terminal:sandbox] ${error}`);
    return { route: "sandbox", sandboxManager: null, error };
  }
  return { route: "sandbox", sandboxManager: args.sandboxManager };
}

export function toSandboxWorkdir(hostWorkdir: string): string | undefined {
  const relative = path.relative(process.cwd(), path.resolve(hostWorkdir));
  if (relative === "") return "/workspace";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `/workspace/${relative}`;
  }
  return undefined;
}
