/**
 * Routes an agent terminal command to either the host or the sandbox: consults
 * local-safe execution mode to choose the route, and — when local-safe mode is
 * required but no SandboxManager is available — fails closed by returning a
 * sandbox route with a null manager plus an error rather than silently running
 * on the host. `toSandboxWorkdir` maps a host working directory onto its
 * `/workspace`-rooted path inside the sandbox (undefined when it escapes it).
 */
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
