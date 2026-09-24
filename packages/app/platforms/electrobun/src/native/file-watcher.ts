/**
 * Workspace File Watcher for Electrobun
 *
 * Watches a workspace directory for file changes and emits events to the
 * webview via a `sendToWebview` callback. Used by the IDE app and the
 * floating chat widget to keep the agent, native editor, and UI in sync.
 *
 * Uses Node's built-in `fs.watch` (recursive mode on macOS and Windows,
 * simulated with per-directory watches on Linux). No external deps required.
 *
 * Design notes:
 * - Multiple watches can be active simultaneously (keyed by watchId).
 * - Rapid file changes are debounced (50 ms) to avoid event floods.
 * - Only regular files are reported (not directories or system files).
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileChangeEventType =
	| "created"
	| "modified"
	| "deleted"
	| "renamed";

export interface FileChangeEvent {
	watchId: string;
	type: FileChangeEventType;
	filePath: string;
	relativePath: string;
	timestamp: number;
}

export interface WatchStatus {
	watchId: string;
	watchPath: string;
	active: boolean;
	startedAt: number;
	eventCount: number;
}

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

function debounce<T extends unknown[]>(
	fn: (...args: T) => void,
	delayMs: number,
): (...args: T) => void {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	return (...args: T) => {
		// Use first arg as debounce key when it's a string (file path)
		const key = typeof args[0] === "string" ? args[0] : "default";
		const existing = timers.get(key);
		if (existing !== undefined) clearTimeout(existing);
		timers.set(
			key,
			setTimeout(() => {
				timers.delete(key);
				fn(...args);
			}, delayMs),
		);
	};
}

// ---------------------------------------------------------------------------
// IGNORED patterns
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".cache",
	".vite",
	"__pycache__",
]);

function shouldIgnorePath(fullPath: string): boolean {
	const parts = fullPath.split(path.sep);
	return parts.some((part) => IGNORED_DIRS.has(part) || part.startsWith("."));
}

// ---------------------------------------------------------------------------
// WorkspaceFileWatcher singleton
// ---------------------------------------------------------------------------

interface WatchEntry {
	watchPath: string;
	watcher: fs.FSWatcher;
	startedAt: number;
	eventCount: number;
}

type SendFileChange = (event: FileChangeEvent) => void;

class WorkspaceFileWatcher {
	private readonly watches = new Map<string, WatchEntry>();
	private counter = 0;

	/**
	 * Start watching `watchPath`.
	 * @returns The new watchId.
	 */
	startWatch(watchPath: string, send: SendFileChange): string {
		if (!fs.existsSync(watchPath)) {
			throw new Error(`Watch path does not exist: ${watchPath}`);
		}

		const watchId = `watch_${++this.counter}`;

		const emitChange = debounce(
			(filePath: string, eventType: FileChangeEventType) => {
				const entry = this.watches.get(watchId);
				if (entry) entry.eventCount++;
				send({
					watchId,
					type: eventType,
					filePath,
					relativePath: path.relative(watchPath, filePath),
					timestamp: Date.now(),
				});
			},
			50,
		);

		const watcher = fs.watch(
			watchPath,
			{ recursive: true, persistent: false },
			(eventName, filename) => {
				if (!filename) return;
				const fullPath = path.resolve(watchPath, filename);
				if (shouldIgnorePath(fullPath)) return;

				let type: FileChangeEventType;
				try {
					const exists = fs.existsSync(fullPath);
					if (!exists) {
						type = "deleted";
					} else {
						// fs.watch reports both "rename" (create/delete) and "change" (modify).
						type = eventName === "rename" ? "created" : "modified";
					}
				} catch {
					type = "modified";
				}

				emitChange(fullPath, type);
			},
		);

		this.watches.set(watchId, {
			watchPath,
			watcher,
			startedAt: Date.now(),
			eventCount: 0,
		});

		return watchId;
	}

	/** Stop a specific watch. */
	stopWatch(watchId: string): boolean {
		const entry = this.watches.get(watchId);
		if (!entry) return false;
		entry.watcher.close();
		this.watches.delete(watchId);
		return true;
	}

	/** Stop all active watches. */
	stopAll(): void {
		for (const [id] of this.watches) {
			this.stopWatch(id);
		}
	}

	/** Returns status for all active watches. */
	listWatches(): WatchStatus[] {
		return Array.from(this.watches.entries()).map(([id, entry]) => ({
			watchId: id,
			watchPath: entry.watchPath,
			active: true,
			startedAt: entry.startedAt,
			eventCount: entry.eventCount,
		}));
	}

	getWatch(watchId: string): WatchStatus | null {
		const entry = this.watches.get(watchId);
		if (!entry) return null;
		return {
			watchId,
			watchPath: entry.watchPath,
			active: true,
			startedAt: entry.startedAt,
			eventCount: entry.eventCount,
		};
	}
}

// Module-level singleton
let _watcher: WorkspaceFileWatcher | null = null;

export function getFileWatcher(): WorkspaceFileWatcher {
	if (!_watcher) {
		_watcher = new WorkspaceFileWatcher();
	}
	return _watcher;
}
