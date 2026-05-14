import path from "node:path";
import { createVirtualFilesystemService } from "./virtual-filesystem.ts";

interface VfsBuiltinShellRequest {
  cwdUri?: string;
  command: string;
  args: readonly string[];
  timeoutMs?: number;
}

interface VfsBuiltinShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  sandbox: "vfs";
}

interface ParsedVfsUri {
  projectId: string;
  virtualPath: string;
}

export function isVfsUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("vfs://");
}

export async function runVfsBuiltinShell(
  request: VfsBuiltinShellRequest,
): Promise<VfsBuiltinShellResult> {
  const startedAt = Date.now();
  const cwd = parseVfsUri(request.cwdUri);
  const vfs = createVirtualFilesystemService({ projectId: cwd.projectId });
  await vfs.initialize();

  try {
    const result =
      isShellCommand(request.command) && request.args[0] === "-c"
        ? await runScript(vfs, cwd.virtualPath, request.args.slice(1).join(" "))
        : await runCommand(vfs, cwd.virtualPath, request.command, [
            ...request.args,
          ]);
    return {
      ...result,
      durationMs: Date.now() - startedAt,
      sandbox: "vfs",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? `${error.message}\n` : String(error),
      durationMs: Date.now() - startedAt,
      sandbox: "vfs",
    };
  }
}

function parseVfsUri(uri: string | undefined): ParsedVfsUri {
  if (!isVfsUri(uri)) {
    throw new Error("[vfs-shell] cwd must be a vfs:// URI");
  }
  const parsed = new URL(uri);
  const projectId = parsed.hostname.trim();
  if (!projectId) {
    throw new Error("[vfs-shell] vfs:// URI is missing a project id");
  }
  return {
    projectId,
    virtualPath: decodeURIComponent(parsed.pathname || "/"),
  };
}

function isShellCommand(command: string): boolean {
  const base = command.split("/").pop();
  return base === "sh" || base === "bash";
}

async function runScript(
  vfs: ReturnType<typeof createVirtualFilesystemService>,
  cwd: string,
  script: string,
): Promise<Omit<VfsBuiltinShellResult, "durationMs" | "sandbox">> {
  const segments = script
    .split(/&&|;/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  let stdout = "";
  let stderr = "";
  for (const segment of segments) {
    const result = await runScriptSegment(vfs, cwd, segment);
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) {
      return { exitCode: result.exitCode, stdout, stderr };
    }
  }
  return { exitCode: 0, stdout, stderr };
}

async function runScriptSegment(
  vfs: ReturnType<typeof createVirtualFilesystemService>,
  cwd: string,
  segment: string,
): Promise<Omit<VfsBuiltinShellResult, "durationMs" | "sandbox">> {
  const redirect = segment.match(/^(.*?)(>>|>)\s*([^\s]+)\s*$/);
  if (redirect) {
    const [, before, op, target] = redirect;
    const result = await runCommandLine(vfs, cwd, before.trim());
    if (result.exitCode !== 0) return result;
    const targetPath = resolveVirtualPath(cwd, stripQuotes(target));
    const existing =
      op === ">>" ? await vfs.readFile(targetPath).catch(() => "") : "";
    await vfs.writeFile(targetPath, existing + result.stdout);
    return { exitCode: 0, stdout: "", stderr: result.stderr };
  }
  return runCommandLine(vfs, cwd, segment);
}

async function runCommandLine(
  vfs: ReturnType<typeof createVirtualFilesystemService>,
  cwd: string,
  line: string,
): Promise<Omit<VfsBuiltinShellResult, "durationMs" | "sandbox">> {
  const [command, ...args] = tokenize(line);
  return runCommand(vfs, cwd, command, args);
}

async function runCommand(
  vfs: ReturnType<typeof createVirtualFilesystemService>,
  cwd: string,
  command: string,
  args: string[],
): Promise<Omit<VfsBuiltinShellResult, "durationMs" | "sandbox">> {
  const name = command.split("/").pop() ?? command;
  if (name === "echo") {
    return { exitCode: 0, stdout: `${args.join(" ")}\n`, stderr: "" };
  }
  if (name === "printf") {
    return { exitCode: 0, stdout: args.join(" "), stderr: "" };
  }
  if (name === "pwd") {
    return { exitCode: 0, stdout: `${cwd || "/"}\n`, stderr: "" };
  }
  if (name === "cat") {
    let stdout = "";
    for (const arg of args) {
      stdout += await vfs.readFile(resolveVirtualPath(cwd, arg));
    }
    return { exitCode: 0, stdout, stderr: "" };
  }
  if (name === "ls") {
    const target = args.find((arg) => !arg.startsWith("-")) ?? ".";
    const entries = await vfs.list(resolveVirtualPath(cwd, target));
    return {
      exitCode: 0,
      stdout: entries.map((entry) => path.posix.basename(entry.path)).join("\n")
        + (entries.length ? "\n" : ""),
      stderr: "",
    };
  }
  return {
    exitCode: 127,
    stdout: "",
    stderr: `[vfs-shell] unsupported command: ${command}\n`,
  };
}

function resolveVirtualPath(cwd: string, input: string): string {
  const cleanInput = stripQuotes(input);
  if (!cleanInput || cleanInput === ".") return cwd || "/";
  if (cleanInput.startsWith("/")) return cleanInput;
  return path.posix.normalize(path.posix.join(cwd || "/", cleanInput));
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function stripQuotes(input: string | undefined): string {
  const value = input ?? "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
