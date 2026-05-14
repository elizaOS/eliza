/**
 * Store-build workspace folder helper.
 *
 * Use under MAS / Flathub / MSIX AppContainer store builds where the OS
 * sandbox scopes filesystem reach to the app container plus user-granted
 * folders. Idempotent: only prompts when no stored folder exists; re-
 * resolves the macOS security-scoped bookmark on subsequent launches.
 *
 * Wire-in points:
 *   1. StartupShell mount-time effect — re-resolves the stored bookmark
 *      every launch so the host process holds an active access grant.
 *   2. Onboarding deployment-step exit — the natural prompt moment for
 *      first-run users on store builds.
 *
 * On non-store builds this is a no-op — direct downloads have full host
 * access and don't need a workspace folder grant.
 */

import {
  pickDesktopWorkspaceFolder,
  resolveDesktopWorkspaceFolderBookmark,
} from "../bridge/electrobun-rpc";
import { isStoreBuild } from "../build-variant";
import {
  clearStoredWorkspaceFolder,
  persistStoredWorkspaceFolder,
  readStoredWorkspaceFolder,
  type StoredWorkspaceFolder,
} from "../storage/workspace-folder";

export type EnsureWorkspaceFolderResult =
  | { kind: "skipped"; reason: "non-store-build" | "not-electrobun" }
  | { kind: "stored"; folder: StoredWorkspaceFolder; freshlyPicked: boolean }
  | { kind: "canceled" }
  | { kind: "stale-bookmark"; oldPath: string };

interface EnsureOptions {
  defaultPath?: string;
  promptTitle?: string;
  forcePicker?: boolean;
}

export async function ensureStoreBuildWorkspaceFolder(
  options: EnsureOptions = {},
): Promise<EnsureWorkspaceFolderResult> {
  if (!isStoreBuild()) {
    return { kind: "skipped", reason: "non-store-build" };
  }

  const existing = readStoredWorkspaceFolder();
  if (existing && !options.forcePicker) {
    if (existing.bookmark) {
      const result = await resolveDesktopWorkspaceFolderBookmark(
        existing.bookmark,
      );
      if (result === null) {
        return { kind: "skipped", reason: "not-electrobun" };
      }
      if (!result.ok) {
        clearStoredWorkspaceFolder();
        return { kind: "stale-bookmark", oldPath: existing.path };
      }
      const resolvedPath =
        typeof result.path === "string" && result.path.length > 0
          ? result.path
          : existing.path;
      return {
        kind: "stored",
        folder: { ...existing, path: resolvedPath },
        freshlyPicked: false,
      };
    }
    return { kind: "stored", folder: existing, freshlyPicked: false };
  }

  const picked = await pickDesktopWorkspaceFolder({
    defaultPath: options.defaultPath,
    promptTitle: options.promptTitle,
  });
  if (picked === null) {
    return { kind: "skipped", reason: "not-electrobun" };
  }
  if (picked.canceled || !picked.path) {
    return { kind: "canceled" };
  }

  const stored = persistStoredWorkspaceFolder({
    path: picked.path,
    bookmark: picked.bookmark ?? null,
  });
  return { kind: "stored", folder: stored, freshlyPicked: true };
}
