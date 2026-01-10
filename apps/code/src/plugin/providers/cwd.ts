import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import * as fs from "fs/promises";
import * as path from "path";

// Global CWD state - defaults to process.cwd()
let currentWorkingDirectory = process.cwd();

/**
 * Get the current working directory
 */
export function getCwd(): string {
  return currentWorkingDirectory;
}

/**
 * Set the current working directory
 */
export async function setCwd(newPath: string): Promise<{ success: boolean; path: string; error?: string }> {
  // Resolve relative paths
  const resolved = path.resolve(currentWorkingDirectory, newPath);
  
  try {
    // Check if path exists and is a directory
    const stats = await fs.stat(resolved);
    
    if (!stats.isDirectory()) {
      return { 
        success: false, 
        path: resolved, 
        error: `Not a directory: ${resolved}` 
      };
    }
    
    currentWorkingDirectory = resolved;
    return { success: true, path: resolved };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return { 
        success: false, 
        path: resolved, 
        error: `Directory not found: ${resolved}` 
      };
    }
    return { 
      success: false, 
      path: resolved, 
      error: `Error accessing directory: ${error.message}` 
    };
  }
}

/**
 * List parent directories for context
 */
function getPathParts(dir: string): string[] {
  const parts: string[] = [];
  let current = dir;
  
  for (let i = 0; i < 3; i++) {
    const parent = path.dirname(current);
    if (parent === current) break;
    parts.unshift(path.basename(current));
    current = parent;
  }
  
  return parts;
}

/**
 * CWD Provider - Injects current working directory into agent context
 */
export const cwdProvider: Provider = {
  name: "CWD",
  description: "Provides the current working directory context",
  dynamic: true,

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const cwd = getCwd();
    const pathParts = getPathParts(cwd);
    const shortPath = pathParts.length > 0 ? `.../${pathParts.join("/")}` : cwd;

    // Get directory contents summary
    let contents = "";
    try {
      const entries = await fs.readdir(cwd, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith(".")).slice(0, 5);
      const files = entries.filter(e => e.isFile() && !e.name.startsWith(".")).slice(0, 5);
      
      if (dirs.length > 0) {
        contents += `\nSubdirectories: ${dirs.map(d => d.name + "/").join(", ")}`;
      }
      if (files.length > 0) {
        contents += `\nFiles: ${files.map(f => f.name).join(", ")}`;
      }
      if (entries.length > 10) {
        contents += `\n(${entries.length} total items)`;
      }
    } catch {
      contents = "\n(Unable to list directory contents)";
    }

    const contextText = `## Current Working Directory
**Path:** ${cwd}
**Short:** ${shortPath}${contents}

Use the CHANGE_DIRECTORY action to navigate to a different directory.
All file operations are relative to this directory.`;

    return {
      text: contextText,
      values: {
        cwd,
        shortPath,
      },
      data: {
        currentWorkingDirectory: cwd,
      },
    };
  },
};
