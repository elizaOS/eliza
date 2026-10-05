import { ElizaError } from "@elizaos/core/protocol";
/**
 * Workspace-folder config persisted in `<stateDir>/workspace-folder.json`.
 *
 * Bridges the Electrobun renderer (writes after a successful workspace-folder
 * pick or bookmark resolve) and the agent runtime (reads at boot to seed
 * `ELIZA_WORKSPACE_DIR`). Both sides run as separate processes and can't
 * see each other's in-memory state, so a JSON file in the shared per-user
 * state dir is the cheapest reliable bridge.
 *
 * The renderer also keeps its own localStorage copy (see
 * `packages/ui/src/storage/workspace-folder.ts`) for renderer UX (button
 * enablement, re-prompt logic). That copy is renderer-only; this JSON file
 * is what crosses the process boundary.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "@elizaos/core";
import { writeJsonFileAtomic } from "./atomic-json-file.js";

export interface WorkspaceFolderConfig {
  path: string;
  bookmark: string | null;
  updatedAt: string;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isWorkspaceFolderConfig(
  value: unknown,
): value is WorkspaceFolderConfig {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== "string" || obj.path.length === 0) return false;
  if (obj.bookmark !== null && typeof obj.bookmark !== "string") return false;
  if (typeof obj.updatedAt !== "string") return false;
  return true;
}

export function workspaceFolderConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveStateDir(env), "workspace-folder.json");
}

export function readWorkspaceFolderConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceFolderConfig | null {
  const filePath = workspaceFolderConfigPath(env);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      // error-policy:J4 an absent workspace selection is an expected,
      // explicitly unavailable state during first-run boot.
      return null;
    }
    throw new ElizaError("Cannot read workspace folder configuration", {
      code: "WORKSPACE_FOLDER_CONFIG_READ_FAILED",
      cause: error,
      context: { filePath },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ElizaError("Malformed workspace folder configuration JSON", {
      code: "WORKSPACE_FOLDER_CONFIG_INVALID",
      cause,
      context: { filePath },
    });
  }
  if (!isWorkspaceFolderConfig(parsed)) {
    throw new ElizaError("Invalid workspace folder configuration", {
      code: "WORKSPACE_FOLDER_CONFIG_INVALID",
      context: { filePath },
    });
  }
  return parsed;
}

export function writeWorkspaceFolderConfig(
  value: Omit<WorkspaceFolderConfig, "updatedAt">,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceFolderConfig {
  const next: WorkspaceFolderConfig = {
    path: value.path,
    bookmark: value.bookmark,
    updatedAt: new Date().toISOString(),
  };
  const filePath = workspaceFolderConfigPath(env);
  writeJsonFileAtomic(filePath, next);
  return next;
}

export function clearWorkspaceFolderConfig(
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    unlinkSync(workspaceFolderConfigPath(env));
  } catch (error) {
    if (isMissingFileError(error)) {
      // error-policy:J6 clearing an already-absent optional selection is an
      // idempotent teardown operation.
      return;
    }
    throw error;
  }
}
