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

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ElizaError } from "../errors.js";
import { resolveStateDir } from "./state-dir.js";

export interface WorkspaceFolderConfig {
	path: string;
	bookmark: string | null;
	updatedAt: string;
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
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return isWorkspaceFolderConfig(parsed) ? parsed : null;
}

/**
 * Read legacy workspace state for migrations that must distinguish first-run
 * absence from corruption or I/O failure.
 */
export function readWorkspaceFolderConfigOrThrow(
	env: NodeJS.ProcessEnv = process.env,
): WorkspaceFolderConfig | null {
	const filePath = workspaceFolderConfigPath(env);
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (cause) {
		if (
			typeof cause === "object" &&
			cause !== null &&
			"code" in cause &&
			cause.code === "ENOENT"
		) {
			return null;
		}
		throw new ElizaError("Workspace folder config could not be read", {
			code: "WORKSPACE_FOLDER_CONFIG_READ_FAILED",
			context: { filePath },
			cause,
			severity: "fatal",
		});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new ElizaError("Workspace folder config is malformed JSON", {
			code: "WORKSPACE_FOLDER_CONFIG_INVALID",
			context: { filePath },
			cause,
			severity: "fatal",
		});
	}
	if (!isWorkspaceFolderConfig(parsed)) {
		throw new ElizaError("Workspace folder config has an invalid schema", {
			code: "WORKSPACE_FOLDER_CONFIG_INVALID",
			context: { filePath },
			severity: "fatal",
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
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

export function clearWorkspaceFolderConfig(
	env: NodeJS.ProcessEnv = process.env,
): void {
	try {
		unlinkSync(workspaceFolderConfigPath(env));
	} catch (cause) {
		if (
			typeof cause === "object" &&
			cause !== null &&
			"code" in cause &&
			cause.code === "ENOENT"
		) {
			// error-policy:J4 an already-absent config is the requested end state.
			return;
		}
		throw new ElizaError("Workspace folder config could not be cleared", {
			code: "WORKSPACE_FOLDER_CONFIG_CLEAR_FAILED",
			context: { filePath: workspaceFolderConfigPath(env) },
			cause,
			severity: "fatal",
		});
	}
}
