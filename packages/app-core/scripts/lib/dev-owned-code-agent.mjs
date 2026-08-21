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
 * package binary is not linked into the root `.bin`, so run the source
 * entrypoint with the `eliza-source` export condition. This keeps the ACP
 * child on the exact checkout sources (especially @elizaos/core) instead of
 * silently mixing a current parent runtime with stale package dist output.
 */
export function resolveDevOwnedCodeAgentCommand({
  cwd,
  configuredCommand,
  bunCommand = "bun",
  exists = existsSync,
}) {
  if (configuredCommand?.trim()) return configuredCommand.trim();

  const candidates = [
    path.join(cwd, "packages", "examples", "code", "src", "acp.ts"),
    path.join(cwd, "eliza", "packages", "examples", "code", "src", "acp.ts"),
  ];
  const entrypoint = candidates.find((candidate) => exists(candidate));
  if (!entrypoint) return undefined;
  return `${quoteCommandArg(bunCommand)} --conditions eliza-source ${quoteCommandArg(entrypoint)}`;
}
