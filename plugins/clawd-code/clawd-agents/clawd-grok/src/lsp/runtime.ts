import { existsSync } from "fs";
import path from "path";
import { getCurrentLspSettings } from "../utils/settings";
import { createWorkspaceLspManager, summarizeLspDiagnostics, type WorkspaceLspManager } from "./manager";
import type { LspDiagnosticFile, LspQueryInput, LspToolResponse } from "./types";

const managers = new Map<string, WorkspaceLspManager>();

export async function queryLsp(cwd: string, input: LspQueryInput): Promise<LspToolResponse> {
  const manager = getOrCreateManager(cwd);
  return manager.query({
    ...input,
    filePath: path.isAbsolute(input.filePath) ? input.filePath : path.resolve(cwd, input.filePath),
  });
}

export async function syncFileWithLsp(
  cwd: string,
  filePath: string,
  content: string,
  save = true,
  waitForDiagnostics = true,
): Promise<LspDiagnosticFile[]> {
  const manager = getOrCreateManager(cwd);
  return manager.syncFile(
    path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath),
    content,
    save,
    waitForDiagnostics,
  );
}

export function isLspToolEnabled(_cwd: string): boolean {
  const settings = getCurrentLspSettings();
  return settings.enabled && settings.tool;
}

export function summarizeDiagnostics(diagnostics: LspDiagnosticFile[]): string | null {
  return summarizeLspDiagnostics(diagnostics);
}

export async function shutdownWorkspaceLspManager(cwd: string): Promise<void> {
  const key = resolveManagerKey(cwd);
  const manager = managers.get(key);
  if (!manager) return;
  managers.delete(key);
  await manager.close();
}

function getOrCreateManager(cwd: string): WorkspaceLspManager {
  const key = resolveManagerKey(cwd);
  const existing = managers.get(key);
  if (existing) return existing;

  const manager = createWorkspaceLspManager(key, getCurrentLspSettings());
  managers.set(key, manager);
  return manager;
}

function resolveManagerKey(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(current, ".clawd")) || existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}
