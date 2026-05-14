/**
 * Renderer-side persistence for the user-chosen workspace folder.
 *
 * Store-distributed desktop builds (MAS / MSIX AppContainer / Flathub) run
 * inside an OS sandbox that scopes filesystem reach to the app container plus
 * user-granted folders. On macOS that grant is a security-scoped
 * NSURLBookmark that MUST be re-resolved on every launch — a bare path
 * string is unusable across launches.
 *
 * This module persists the picker result so first-run onboarding records
 * `{path, bookmark}` once and boot-time agent setup reads it back. The
 * matching shared JSON config lives at `<stateDir>/workspace-folder.json`
 * and is written by the Electrobun bun-side RPC handler; that file is what
 * the agent runtime (separate Node process) consumes. This localStorage
 * copy is the renderer's own UX state (button enablement, re-prompt logic).
 *
 * Linux / Flathub picker results have `bookmark: null` (portal grants do
 * not need re-resolution). Windows AppContainer pickers also return null.
 * The bookmark field is macOS-only.
 */

const STORAGE_KEY = "eliza.workspace-folder";

export interface StoredWorkspaceFolder {
	path: string;
	bookmark: string | null;
	updatedAt: string;
}

interface JsonStorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function getStorage(): JsonStorageLike | null {
	if (typeof window === "undefined") return null;
	const w = window as typeof window & { localStorage?: JsonStorageLike };
	return w.localStorage ?? null;
}

function isStoredWorkspaceFolder(
	value: unknown,
): value is StoredWorkspaceFolder {
	if (value === null || typeof value !== "object") return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.path !== "string" || obj.path.length === 0) return false;
	if (obj.bookmark !== null && typeof obj.bookmark !== "string") return false;
	if (typeof obj.updatedAt !== "string") return false;
	return true;
}

export function readStoredWorkspaceFolder(): StoredWorkspaceFolder | null {
	const storage = getStorage();
	if (!storage) return null;
	const raw = storage.getItem(STORAGE_KEY);
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return isStoredWorkspaceFolder(parsed) ? parsed : null;
}

export function persistStoredWorkspaceFolder(
	value: Omit<StoredWorkspaceFolder, "updatedAt">,
): StoredWorkspaceFolder {
	const storage = getStorage();
	const next: StoredWorkspaceFolder = {
		path: value.path,
		bookmark: value.bookmark,
		updatedAt: new Date().toISOString(),
	};
	if (storage) {
		storage.setItem(STORAGE_KEY, JSON.stringify(next));
	}
	return next;
}

export function clearStoredWorkspaceFolder(): void {
	const storage = getStorage();
	if (!storage) return;
	storage.removeItem(STORAGE_KEY);
}

export const WORKSPACE_FOLDER_STORAGE_KEY = STORAGE_KEY;
