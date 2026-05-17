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
export interface StoredWorkspaceFolder {
  path: string;
  bookmark: string | null;
  updatedAt: string;
}
export declare function readStoredWorkspaceFolder(): StoredWorkspaceFolder | null;
export declare function persistStoredWorkspaceFolder(
  value: Omit<StoredWorkspaceFolder, "updatedAt">,
): StoredWorkspaceFolder;
export declare function clearStoredWorkspaceFolder(): void;
export declare const WORKSPACE_FOLDER_STORAGE_KEY = "eliza.workspace-folder";
//# sourceMappingURL=workspace-folder.d.ts.map
