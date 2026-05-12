/**
 * Native Editor Bridge for Electrobun
 *
 * Detects installed native code editors (VS Code, Cursor, Windsurf, Antigravity,
 * etc.) and launches workspace folders in them. Tracks the active editor session
 * so the floating chat widget and file watcher know which session is live.
 *
 * Design notes:
 * - All detection is cross-platform (macOS, Linux, Windows).
 * - The bridge does NOT control the native editor process; it only launches it.
 * - Session state is kept in memory. On app restart the session is lost (by design –
 *   the floating chat reconnects to the running agent, not to a saved session token).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Editor catalogue
// ---------------------------------------------------------------------------

export type NativeEditorId =
	| "vscode"
	| "cursor"
	| "windsurf"
	| "antigravity"
	| "zed"
	| "sublime";

export interface NativeEditorInfo {
	id: NativeEditorId;
	label: string;
	installed: boolean;
	/** CLI command that opens a path, e.g. "code" */
	command: string;
}

export interface EditorSession {
	editorId: NativeEditorId;
	workspacePath: string;
	startedAt: number;
}

interface EditorSpec {
	id: NativeEditorId;
	label: string;
	/** Primary CLI command to try first */
	command: string;
	/** Extra candidate paths per platform to search for the binary */
	candidates?: Partial<Record<NodeJS.Platform, string[]>>;
}

const EDITOR_SPECS: EditorSpec[] = [
	{
		id: "vscode",
		label: "VS Code",
		command: "code",
		candidates: {
			darwin: [
				"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
				`${os.homedir()}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`,
			],
			linux: ["/usr/bin/code", "/usr/local/bin/code"],
			win32: [
				path.join(
					os.homedir(),
					"AppData",
					"Local",
					"Programs",
					"Microsoft VS Code",
					"bin",
					"code.cmd",
				),
			],
		},
	},
	{
		id: "cursor",
		label: "Cursor",
		command: "cursor",
		candidates: {
			darwin: [
				"/Applications/Cursor.app/Contents/MacOS/Cursor",
				`${os.homedir()}/Applications/Cursor.app/Contents/MacOS/Cursor`,
			],
			linux: ["/usr/bin/cursor", "/usr/local/bin/cursor"],
			win32: [
				path.join(
					os.homedir(),
					"AppData",
					"Local",
					"Programs",
					"cursor",
					"Cursor.exe",
				),
			],
		},
	},
	{
		id: "windsurf",
		label: "Windsurf",
		command: "windsurf",
		candidates: {
			darwin: [
				"/Applications/Windsurf.app/Contents/MacOS/Windsurf",
				`${os.homedir()}/Applications/Windsurf.app/Contents/MacOS/Windsurf`,
			],
			linux: ["/usr/bin/windsurf", "/usr/local/bin/windsurf"],
			win32: [
				path.join(
					os.homedir(),
					"AppData",
					"Local",
					"Programs",
					"windsurf",
					"Windsurf.exe",
				),
			],
		},
	},
	{
		id: "antigravity",
		label: "Antigravity",
		command: "ag",
		candidates: {
			darwin: [
				"/Applications/Antigravity.app/Contents/MacOS/Antigravity",
				`${os.homedir()}/Applications/Antigravity.app/Contents/MacOS/Antigravity`,
			],
		},
	},
	{
		id: "zed",
		label: "Zed",
		command: "zed",
		candidates: {
			darwin: [
				"/Applications/Zed.app/Contents/MacOS/cli",
				`${os.homedir()}/Applications/Zed.app/Contents/MacOS/cli`,
			],
			linux: ["/usr/bin/zed", "/usr/local/bin/zed"],
		},
	},
	{
		id: "sublime",
		label: "Sublime Text",
		command: "subl",
		candidates: {
			darwin: [
				"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl",
			],
			linux: ["/usr/bin/subl", "/usr/local/bin/subl"],
			win32: [path.join("C:", "Program Files", "Sublime Text", "subl.exe")],
		},
	},
];

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Returns true when a path exists and is executable. */
function isExecutable(p: string): boolean {
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Returns true when a CLI command is available via PATH. */
function isCommandOnPath(cmd: string): boolean {
	const which = process.platform === "win32" ? "where" : "which";
	try {
		const result = spawnSync(which, [cmd], {
			stdio: "pipe",
			encoding: "utf8",
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

function detectEditor(spec: EditorSpec): NativeEditorInfo {
	if (isCommandOnPath(spec.command)) {
		return {
			id: spec.id,
			label: spec.label,
			installed: true,
			command: spec.command,
		};
	}
	const platform = process.platform as NodeJS.Platform;
	const candidates = spec.candidates?.[platform] ?? [];
	const resolved = candidates.find((p) => isExecutable(p));
	if (resolved) {
		return {
			id: spec.id,
			label: spec.label,
			installed: true,
			command: resolved,
		};
	}
	return {
		id: spec.id,
		label: spec.label,
		installed: false,
		command: spec.command,
	};
}

// ---------------------------------------------------------------------------
// Editor Bridge singleton
// ---------------------------------------------------------------------------

let _activeSession: EditorSession | null = null;

/** Returns the currently installed editors. */
export function detectInstalledEditors(): NativeEditorInfo[] {
	return EDITOR_SPECS.map(detectEditor);
}

/** Returns only the editors that are detected as installed. */
export function listInstalledEditors(): NativeEditorInfo[] {
	return detectInstalledEditors().filter((e) => e.installed);
}

/**
 * Opens `workspacePath` in the selected editor.
 *
 * Throws if the editor is not installed or the workspace does not exist.
 */
export function openInEditor(
	editorId: NativeEditorId,
	workspacePath: string,
): EditorSession {
	if (!fs.existsSync(workspacePath)) {
		throw new Error(`Workspace path does not exist: ${workspacePath}`);
	}

	const info = detectEditor(
		EDITOR_SPECS.find((s) => s.id === editorId) ??
			(() => {
				throw new Error(`Unknown editor id: ${editorId}`);
			})(),
	);

	if (!info.installed) {
		throw new Error(`Editor "${info.label}" is not installed`);
	}

	// Detach the editor process — we do not own its lifecycle.
	const child = Bun.spawn([info.command, workspacePath], {
		stdio: ["ignore", "ignore", "ignore"],
		env: process.env as Record<string, string>,
	});

	// We do not await; the editor runs independently.
	child.unref?.();

	const session: EditorSession = {
		editorId,
		workspacePath,
		startedAt: Date.now(),
	};
	_activeSession = session;
	return session;
}

/** Returns the current active editor session (or null if none). */
export function getActiveEditorSession(): EditorSession | null {
	return _activeSession;
}

/** Clears the active editor session (does NOT close the editor). */
export function clearActiveEditorSession(): void {
	_activeSession = null;
}

// Singleton accessor — matches the pattern used by other native modules.
export function getEditorBridge() {
	return {
		listInstalledEditors,
		openInEditor,
		getActiveEditorSession,
		clearActiveEditorSession,
	};
}
