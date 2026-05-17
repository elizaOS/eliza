import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface IntegrationTelemetrySpan {
	success: (args?: { statusCode?: number }) => void;
	failure: (args?: {
		statusCode?: number;
		error?: unknown;
		errorKind?: string;
	}) => void;
}

export function createIntegrationTelemetrySpan(_meta: {
	boundary:
		| "cloud"
		| "wallet"
		| "marketplace"
		| "mcp"
		| "lifeops"
		| "browser-bridge";
	operation: string;
	timeoutMs?: number;
}): IntegrationTelemetrySpan {
	return {
		success: () => {},
		failure: () => {},
	};
}

const PROJECT_WORKSPACE_MARKERS = [
	"AGENTS.md",
	"CLAUDE.md",
	"package.json",
	"skills",
	".git",
] as const;

function resolveUserPath(value: string, homeDir: string): string {
	if (value === "~") return homeDir;
	if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
	return path.resolve(value);
}

function hasProjectWorkspaceMarker(candidateDir: string): boolean {
	return PROJECT_WORKSPACE_MARKERS.some((marker) =>
		existsSync(path.join(candidateDir, marker)),
	);
}

export function resolveDefaultAgentWorkspaceDir(
	env: NodeJS.ProcessEnv = process.env,
	homedir: () => string = os.homedir,
	cwd: () => string = process.cwd,
): string {
	const homeDir = homedir();
	const explicitWorkspace = env.ELIZA_WORKSPACE_DIR?.trim();
	if (explicitWorkspace) {
		return resolveUserPath(explicitWorkspace, homeDir);
	}

	const stateDir = resolveUserPath(env.ELIZA_STATE_DIR?.trim() || "~/.eliza", homeDir);
	if (!env.ELIZA_STATE_DIR?.trim() && !env.MILADY_STATE_DIR?.trim()) {
		const runtimeCwd = cwd().trim();
		if (runtimeCwd && hasProjectWorkspaceMarker(runtimeCwd)) {
			return resolveUserPath(runtimeCwd, homeDir);
		}
	}

	const profile = env.ELIZA_PROFILE?.trim();
	if (profile && profile.toLowerCase() !== "default") {
		return path.join(stateDir, `workspace-${profile}`);
	}
	return path.join(stateDir, "workspace");
}
