/**
 * Workspace-root discovery and the default bun command used when the training
 * runners shell out to sibling packages, resolving the monorepo root by walking
 * up for workspace markers.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function discoverWorkspaceRoot(
  startDir = process.cwd(),
): string | undefined {
  let current = resolve(startDir);
  while (true) {
    if (
      existsSync(join(current, "packages", "feed", "apps", "cli")) &&
      existsSync(join(current, "packages", "app-core"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolveWorkspaceRoot(input?: string): string {
  return resolve(input ?? discoverWorkspaceRoot() ?? process.cwd());
}

export function defaultBunCommand(): string {
  return (process.versions as Record<string, string | undefined>).bun
    ? process.execPath
    : "bun";
}
