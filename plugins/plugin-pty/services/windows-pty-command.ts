/**
 * Windows command lookup for the node-pty backend. node-pty's ConPTY agent
 * searches `Path` for the exact file name and does not try `PATHEXT`, so a bare
 * name such as `cmd` or `bun` fails with "File not found: ". Bun's terminal and
 * POSIX PTYs already resolve bare names.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { PtySpawn } from "./pty-types";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    // error-policy:J3 an unreadable candidate is not a match; try the next one.
    return false;
  }
}

function envValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const key = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === name,
  );
  return key === undefined ? undefined : env[key];
}

/**
 * Resolve a bare command name (no directory, no extension) to the first
 * `Path` entry that holds it with a `PATHEXT` extension. Any other command,
 * and a name that is not found, is returned unchanged.
 */
export function resolveWindowsPtyCommand(
  command: string,
  env: Record<string, string | undefined>,
  exists: (candidate: string) => boolean = isFile,
): string {
  const win = path.win32;
  if (
    !command ||
    command.includes("/") ||
    command.includes("\\") ||
    win.extname(command) !== ""
  )
    return command;
  const searchPath = envValue(env, "PATH") ?? "";
  const extensions = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));
  for (const directory of searchPath.split(";")) {
    if (!directory || !win.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = win.join(directory, `${command}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return command;
}

/** Wrap a node-pty `spawn` so bare Windows command names resolve first. */
export function withWindowsCommandLookup(spawn: PtySpawn): PtySpawn {
  return (file, args, options) =>
    spawn(
      resolveWindowsPtyCommand(file, {
        PATHEXT: process.env.PATHEXT,
        ...(options.env ?? process.env),
      }),
      args,
      options,
    );
}
