import { createVirtualFilesystemService } from "./virtual-filesystem.ts";

export interface VfsBuiltinShellRequest {
  cwdUri: string;
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
}

export interface VfsBuiltinShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  sandbox: "vfs";
}

interface ParsedVfsUri {
  projectId: string;
  path: string;
}

export function isVfsUri(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("vfs://");
}

export async function runVfsBuiltinShell(
  req: VfsBuiltinShellRequest,
): Promise<VfsBuiltinShellResult> {
  const start = Date.now();
  try {
    const cwd = parseVfsUri(req.cwdUri);
    const invocation = normalizeInvocation(req.command, req.args ?? []);
    const vfs = createVirtualFilesystemService({ projectId: cwd.projectId });
    await vfs.initialize();

    const stdout = await runBuiltin(vfs, cwd.path, invocation);
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      durationMs: Date.now() - start,
      sandbox: "vfs",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
      sandbox: "vfs",
    };
  }
}

async function runBuiltin(
  vfs: ReturnType<typeof createVirtualFilesystemService>,
  cwd: string,
  argv: string[],
): Promise<string> {
  const [command, ...args] = argv;
  switch (command) {
    case "pwd":
      return `${toDisplayPath(cwd)}\n`;
    case "ls":
      return await list(vfs, resolveVfsPath(cwd, args[0] ?? "."));
    case "cat":
      return await read(vfs, resolveVfsPath(cwd, required(args[0], "cat path")));
    case "mkdir":
      await vfs.writeFile(
        joinVfsPath(resolveVfsPath(cwd, required(args[0], "mkdir path")), ".keep"),
        "",
      );
      await vfs.delete(
        joinVfsPath(resolveVfsPath(cwd, required(args[0], "mkdir path")), ".keep"),
      );
      return "";
    case "rm":
      await vfs.delete(resolveVfsPath(cwd, required(args[0], "rm path")));
      return "";
    case "echo":
      return await echo(vfs, cwd, args);
    default:
      throw new Error(
        `VFS shell supports pwd, ls, cat, mkdir, rm, and echo > file; got ${command ?? "(empty)"}`,
      );
  }
}

async function list(
  vfs: ReturnType<typeof createVirtualFilesystemService>,
  path: string,
): Promise<string> {
  const entries = await vfs.list(path, { recursive: false });
  return entries
    .map((entry) =>
      entry.type === "directory"
        ? `${entry.path.replace(/^\//, "")}/`
        : entry.path.replace(/^\//, ""),
    )
    .join("\n")
    .concat(entries.length > 0 ? "\n" : "");
}

async function read(
  vfs: ReturnType<typeof createVirtualFilesystemService>,
  path: string,
): Promise<string> {
  return await vfs.readFile(path);
}

async function echo(
  vfs: ReturnType<typeof createVirtualFilesystemService>,
  cwd: string,
  args: string[],
): Promise<string> {
  const redirect = args.indexOf(">");
  if (redirect === -1) {
    return `${args.join(" ")}\n`;
  }
  const target = required(args[redirect + 1], "echo redirect path");
  const content = args.slice(0, redirect).join(" ");
  await vfs.writeFile(resolveVfsPath(cwd, target), `${content}\n`);
  return "";
}

function parseVfsUri(uri: string): ParsedVfsUri {
  const parsed = new URL(uri);
  if (parsed.protocol !== "vfs:" || !parsed.hostname) {
    throw new Error(`Invalid VFS uri: ${uri}`);
  }
  return {
    projectId: parsed.hostname,
    path: decodeURIComponent(parsed.pathname || "/"),
  };
}

function normalizeInvocation(command: string, args: readonly string[]): string[] {
  if (isShellCommand(command)) {
    const inline = commandLineFromShellArgs(args);
    if (!inline) {
      throw new Error("VFS shell requires a command after -c");
    }
    return splitCommandLine(inline);
  }
  return [command, ...args];
}

function isShellCommand(command: string): boolean {
  return /(?:^|[/\\])(?:sh|bash|zsh|cmd|powershell|pwsh)(?:\.exe)?$/i.test(
    command,
  );
}

function commandLineFromShellArgs(args: readonly string[]): string | null {
  const index = args.findIndex((arg) => arg === "-c" || arg === "/c");
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function splitCommandLine(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) result.push(current);
  return result;
}

function resolveVfsPath(cwd: string, value: string): string {
  if (value.startsWith("/")) return value;
  return joinVfsPath(cwd, value);
}

function joinVfsPath(left: string, right: string): string {
  return `${left.replace(/\/+$/, "")}/${right.replace(/^\/+/, "")}`;
}

function toDisplayPath(path: string): string {
  return path || "/";
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}
