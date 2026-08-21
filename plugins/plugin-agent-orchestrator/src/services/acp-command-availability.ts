import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { splitCommandLine } from "./acp-native-transport.js";

function executablePath(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (path.isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\")) {
    return path.resolve(cwd, command);
  }
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(candidate: string | undefined): boolean {
  if (!candidate) return false;
  try {
    accessSync(
      candidate,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

/** Verify that a configured ACP command can start, including local script entrypoints. */
export function isAcpCommandAvailable(
  input: string | undefined,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const { command, args } = splitCommandLine(input?.trim() ?? "");
  if (!command) return false;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  if (!isExecutable(executablePath(command, cwd, env))) return false;

  // A runtime executable alone is not enough: `bun /missing/acp.js` and
  // `node /missing/acp.js` otherwise look installed and fail only after the
  // user submits a coding task.
  const runtime = path
    .basename(command)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  const entrypoint = args[0];
  if (
    (runtime === "bun" || runtime === "node") &&
    entrypoint &&
    !entrypoint.startsWith("-")
  ) {
    const resolved = path.isAbsolute(entrypoint)
      ? entrypoint
      : path.resolve(cwd, entrypoint);
    if (!existsSync(resolved)) return false;
  }
  return true;
}
