import { existsSync } from "node:fs";
import path from "node:path";

function quoteCommandArg(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Resolve the first-party eliza-code ACP entrypoint in a source checkout.
 *
 * Published runtimes can provide `eliza-code-acp` on PATH or configure
 * ELIZA_ELIZAOS_ACP_COMMAND explicitly. During monorepo development the
 * package binary is built in-place and is not linked into the root `.bin`, so
 * make the owned adapter automatic instead of advertising a coding helper
 * that will fail only after the user submits a task.
 */
export function resolveDevOwnedCodeAgentCommand({
  cwd,
  configuredCommand,
  bunCommand = "bun",
  exists = existsSync,
}) {
  if (configuredCommand?.trim()) return configuredCommand.trim();

  const candidates = [
    path.join(cwd, "packages", "examples", "code", "dist", "acp.js"),
    path.join(cwd, "eliza", "packages", "examples", "code", "dist", "acp.js"),
  ];
  const entrypoint = candidates.find((candidate) => exists(candidate));
  if (!entrypoint) return undefined;
  return `${quoteCommandArg(bunCommand)} ${quoteCommandArg(entrypoint)}`;
}
