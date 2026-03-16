/**
 * File system operations for sandbox environments.
 *
 * Uses native Vercel Sandbox SDK methods for better performance:
 * - sandbox.readFile() instead of shell `cat`
 * - sandbox.writeFiles() instead of base64 encoding through node
 * - sandbox.mkDir() instead of shell `mkdir -p`
 */

import { logger } from "@/lib/utils/logger";
import type { SandboxInstance } from "./types";
import { isPathAllowed, ALLOWED_DIRECTORIES } from "./security";

/**
 * Convert a ReadableStream to string.
 * Used to process file content from sandbox.readFile()
 */
async function streamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    // Flush remaining bytes
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read a file from the sandbox using native SDK method.
 * Falls back to shell command if native method is unavailable.
 */
export async function readFileViaSh(
  sandbox: SandboxInstance,
  filePath: string,
): Promise<string | null> {
  try {
    // Use native SDK method (preferred)
    if (typeof sandbox.readFile === "function") {
      const stream = await sandbox.readFile({ path: filePath });
      if (!stream) {
        return null;
      }
      return await streamToString(stream);
    }
  } catch (error) {
    // Log and fall back to shell command
    logger.debug("Native readFile failed, falling back to shell", {
      path: filePath,
      error: error instanceof Error ? error.message : "Unknown",
    });
  }

  // Fallback: use shell command
  const result = await sandbox.runCommand({ cmd: "cat", args: [filePath] });
  return result.exitCode === 0 ? await result.stdout() : null;
}

/**
 * Write a file to the sandbox using native SDK method.
 * Validates path against security rules before writing.
 * Falls back to shell command if native method is unavailable.
 */
export async function writeFileViaSh(
  sandbox: SandboxInstance,
  filePath: string,
  content: string,
): Promise<void> {
  if (!isPathAllowed(filePath)) {
    throw new Error(
      `Path not allowed: ${filePath}. Files must be in allowed directories (${ALLOWED_DIRECTORIES.join(", ")}) or match allowed root patterns (*.md, *.txt, config files, etc.)`,
    );
  }

  const dir = filePath.split("/").slice(0, -1).join("/");

  try {
    // Use native SDK methods (preferred)
    if (
      typeof sandbox.mkDir === "function" &&
      typeof sandbox.writeFiles === "function"
    ) {
      // Create directory if needed
      if (dir) {
        await sandbox.mkDir(dir);
      }

      // Write file using native method
      await sandbox.writeFiles([
        {
          path: filePath,
          content: Buffer.from(content, "utf-8"),
        },
      ]);
      return;
    }
  } catch (error) {
    // Log and fall back to shell command
    logger.debug("Native writeFiles failed, falling back to shell", {
      path: filePath,
      error: error instanceof Error ? error.message : "Unknown",
    });
  }

  // Fallback: use shell commands with base64 encoding
  if (dir) {
    await sandbox.runCommand({ cmd: "mkdir", args: ["-p", dir] });
  }

  const base64Content = Buffer.from(content, "utf-8").toString("base64");
  const script = `require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64').toString('utf-8'))`;
  const result = await sandbox.runCommand({
    cmd: "node",
    args: ["-e", script, filePath, base64Content],
  });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to write ${filePath}: ${await result.stderr()}`);
  }
}

/**
 * Write multiple files to the sandbox in a single batch operation.
 * More efficient than multiple writeFileViaSh calls.
 */
export async function writeFilesViaSh(
  sandbox: SandboxInstance,
  files: Array<{ path: string; content: string }>,
): Promise<{
  written: string[];
  failed: Array<{ path: string; error: string }>;
}> {
  const written: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  // Validate all paths first
  for (const file of files) {
    if (!isPathAllowed(file.path)) {
      failed.push({
        path: file.path,
        error: `Path not allowed: ${file.path}`,
      });
    }
  }

  const validFiles = files.filter(
    (f) => !failed.some((ff) => ff.path === f.path),
  );

  if (validFiles.length === 0) {
    return { written, failed };
  }

  try {
    // Use native SDK batch write (preferred)
    if (typeof sandbox.writeFiles === "function") {
      // Collect all unique directories
      const dirs = new Set<string>();
      for (const file of validFiles) {
        const dir = file.path.split("/").slice(0, -1).join("/");
        if (dir) dirs.add(dir);
      }

      // Create directories first (if mkDir is available)
      if (typeof sandbox.mkDir === "function") {
        for (const dir of dirs) {
          try {
            await sandbox.mkDir(dir);
          } catch {
            // Directory might already exist, ignore
          }
        }
      }

      // Batch write all files at once
      await sandbox.writeFiles(
        validFiles.map((f) => ({
          path: f.path,
          content: Buffer.from(f.content, "utf-8"),
        })),
      );

      written.push(...validFiles.map((f) => f.path));
      return { written, failed };
    }
  } catch (error) {
    logger.debug(
      "Native batch writeFiles failed, falling back to individual writes",
      {
        fileCount: validFiles.length,
        error: error instanceof Error ? error.message : "Unknown",
      },
    );
  }

  // Fallback: write files individually
  for (const file of validFiles) {
    try {
      await writeFileViaSh(sandbox, file.path, file.content);
      written.push(file.path);
    } catch (error) {
      failed.push({
        path: file.path,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { written, failed };
}

/**
 * Create a directory in the sandbox using native SDK method.
 * Falls back to shell command if native method is unavailable.
 */
export async function mkDirViaSh(
  sandbox: SandboxInstance,
  dirPath: string,
): Promise<void> {
  try {
    // Use native SDK method (preferred)
    if (typeof sandbox.mkDir === "function") {
      await sandbox.mkDir(dirPath);
      return;
    }
  } catch (error) {
    logger.debug("Native mkDir failed, falling back to shell", {
      path: dirPath,
      error: error instanceof Error ? error.message : "Unknown",
    });
  }

  // Fallback: use shell command
  await sandbox.runCommand({ cmd: "mkdir", args: ["-p", dirPath] });
}

/**
 * List files in a directory, excluding common non-source directories.
 * Uses shell command as SDK doesn't have a native list method.
 */
export async function listFilesViaSh(
  sandbox: SandboxInstance,
  dirPath: string,
): Promise<string[]> {
  const excludes = [
    ".git",
    ".next",
    "node_modules",
    ".pnpm",
    ".cache",
    ".turbo",
    "dist",
    ".vercel",
  ];
  const pruneArgs = excludes.map((d) => `-name "${d}" -prune`).join(" -o ");
  const findCmd = `find ${dirPath} \\( ${pruneArgs} \\) -o -type f -print 2>/dev/null | head -200`;

  const result = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", findCmd],
  });
  return result.exitCode === 0
    ? (await result.stdout()).split("\n").filter(Boolean)
    : [];
}
