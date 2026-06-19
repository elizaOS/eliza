import * as path from "node:path";

let currentWorkingDirectory = process.cwd();

export function getCwd(): string {
  return currentWorkingDirectory;
}

export async function setCwd(
  nextPath: string,
): Promise<{ success: boolean; path: string; error?: string }> {
  const resolved = path.resolve(currentWorkingDirectory, nextPath);

  try {
    process.chdir(resolved);
    currentWorkingDirectory = resolved;
    return { success: true, path: resolved };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, path: resolved, error: msg };
  }
}
