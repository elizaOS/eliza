import fsp from "node:fs/promises";
import path from "node:path";
import { createVirtualFilesystemService } from "./virtual-filesystem.ts";

interface VfsBuiltinShellRequest {
  cwdUri?: string;
  command: string;
  args?: readonly string[];
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

type VfsService = ReturnType<typeof createVirtualFilesystemService>;
type VfsBuiltinCommandResult = Omit<
  VfsBuiltinShellResult,
  "durationMs" | "sandbox"
>;

interface SearchOptions {
  ignoreCase: boolean;
  lineNumber: boolean;
  filesWithMatches: boolean;
  invertMatch: boolean;
}

interface SearchTarget {
  path: string;
  contents: string;
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
  const args = [...(request.args ?? [])];

  try {
    const result =
      isShellCommand(request.command) && args[0] === "-c"
        ? await runScript(vfs, cwd.virtualPath, args.slice(1).join(" "))
        : await runCommand(vfs, cwd.virtualPath, request.command, args);
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
  vfs: VfsService,
  cwd: string,
  script: string,
): Promise<VfsBuiltinCommandResult> {
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
  vfs: VfsService,
  cwd: string,
  segment: string,
): Promise<VfsBuiltinCommandResult> {
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
  vfs: VfsService,
  cwd: string,
  line: string,
): Promise<VfsBuiltinCommandResult> {
  const [command, ...args] = tokenize(line);
  if (!command) return { exitCode: 0, stdout: "", stderr: "" };
  return runCommand(vfs, cwd, command, args);
}

async function runCommand(
  vfs: VfsService,
  cwd: string,
  command: string,
  args: string[],
): Promise<VfsBuiltinCommandResult> {
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
  if (name === "mkdir") {
    return mkdir(vfs, cwd, args);
  }
  if (name === "rm") {
    return rm(vfs, cwd, args);
  }
  if (name === "ls") {
    const target = args.find((arg) => !arg.startsWith("-")) ?? ".";
    const entries = await vfs.list(resolveVirtualPath(cwd, target));
    return {
      exitCode: 0,
      stdout:
        entries.map((entry) => path.posix.basename(entry.path)).join("\n") +
        (entries.length ? "\n" : ""),
      stderr: "",
    };
  }
  if (name === "grep") {
    return grep(vfs, cwd, args);
  }
  if (name === "rg") {
    return rg(vfs, cwd, args);
  }
  return {
    exitCode: 127,
    stdout: "",
    stderr: `[vfs-shell] unsupported command: ${command}\n`,
  };
}

async function mkdir(
  vfs: VfsService,
  cwd: string,
  args: string[],
): Promise<VfsBuiltinCommandResult> {
  const optionArgs = args.filter((arg) => arg.startsWith("-"));
  const parents = optionArgs.some((arg) => arg === "-p" || arg.includes("p"));
  const targets = args.filter((arg) => !arg.startsWith("-"));
  if (targets.length === 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "mkdir: missing operand\n",
    };
  }

  for (const target of targets) {
    await mkdirVirtualPath(vfs, resolveVirtualPath(cwd, target), parents);
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}

async function rm(
  vfs: VfsService,
  cwd: string,
  args: string[],
): Promise<VfsBuiltinCommandResult> {
  const optionArgs = args.filter((arg) => arg.startsWith("-"));
  const recursive = optionArgs.some(
    (arg) => arg === "-r" || arg === "-R" || arg === "-rf" || arg === "-fr",
  );
  const force = optionArgs.some((arg) => arg.includes("f"));
  const targets = args.filter((arg) => !arg.startsWith("-"));
  if (targets.length === 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "rm: missing operand\n",
    };
  }

  for (const target of targets) {
    try {
      await vfs.delete(resolveVirtualPath(cwd, target), { recursive });
    } catch (error) {
      if (
        force &&
        error instanceof Error &&
        "code" in error &&
        error.code === "NOT_FOUND"
      ) {
        continue;
      }
      throw error;
    }
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}

async function grep(
  vfs: VfsService,
  cwd: string,
  args: string[],
): Promise<VfsBuiltinCommandResult> {
  const parsed = parseSearchArgs(args, {
    ignoreCase: false,
    lineNumber: false,
    filesWithMatches: false,
    invertMatch: false,
  });
  if (!parsed.pattern) {
    return { exitCode: 2, stdout: "", stderr: "grep: missing pattern\n" };
  }
  const targets = await collectSearchTargets(vfs, cwd, parsed.targets);
  return searchTargets("grep", parsed.pattern, parsed.options, targets);
}

async function rg(
  vfs: VfsService,
  cwd: string,
  args: string[],
): Promise<VfsBuiltinCommandResult> {
  if (args.includes("--files")) {
    const targets = await collectSearchTargets(
      vfs,
      cwd,
      args.filter((arg) => arg !== "--files" && !arg.startsWith("-")),
    );
    return {
      exitCode: 0,
      stdout:
        targets.map((target) => target.path).join("\n") +
        (targets.length ? "\n" : ""),
      stderr: "",
    };
  }

  const parsed = parseSearchArgs(args, {
    ignoreCase: false,
    lineNumber: true,
    filesWithMatches: false,
    invertMatch: false,
  });
  if (!parsed.pattern) {
    return { exitCode: 2, stdout: "", stderr: "rg: missing pattern\n" };
  }
  const targets = await collectSearchTargets(vfs, cwd, parsed.targets);
  return searchTargets("rg", parsed.pattern, parsed.options, targets);
}

function parseSearchArgs(
  args: string[],
  defaults: SearchOptions,
): { options: SearchOptions; pattern: string | null; targets: string[] } {
  const options = { ...defaults };
  const positionals: string[] = [];
  let endOfOptions = false;

  for (const arg of args) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("--")) {
      if (arg === "--ignore-case") options.ignoreCase = true;
      if (arg === "--line-number") options.lineNumber = true;
      if (arg === "--files-with-matches") options.filesWithMatches = true;
      if (arg === "--invert-match") options.invertMatch = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-") && arg.length > 1) {
      for (const flag of arg.slice(1)) {
        if (flag === "i") options.ignoreCase = true;
        if (flag === "n") options.lineNumber = true;
        if (flag === "l") options.filesWithMatches = true;
        if (flag === "v") options.invertMatch = true;
      }
      continue;
    }
    positionals.push(arg);
  }

  const [pattern = null, ...targets] = positionals;
  return { options, pattern, targets };
}

async function searchTargets(
  tool: "grep" | "rg",
  pattern: string,
  options: SearchOptions,
  targets: SearchTarget[],
): Promise<VfsBuiltinCommandResult> {
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, options.ignoreCase ? "i" : "");
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${tool}: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  const lines: string[] = [];
  for (const target of targets) {
    let fileMatched = false;
    const contentLines = target.contents.endsWith("\n")
      ? target.contents.slice(0, -1).split(/\r?\n/)
      : target.contents.split(/\r?\n/);

    for (const [index, line] of contentLines.entries()) {
      const matched = matcher.test(line);
      const selected = options.invertMatch ? !matched : matched;
      if (!selected) continue;
      fileMatched = true;
      if (options.filesWithMatches) break;
      lines.push(formatSearchMatch(target.path, index + 1, line, options));
    }

    if (options.filesWithMatches && fileMatched) {
      lines.push(target.path);
    }
  }

  return {
    exitCode: lines.length > 0 ? 0 : 1,
    stdout: lines.join("\n") + (lines.length ? "\n" : ""),
    stderr: "",
  };
}

function formatSearchMatch(
  filePath: string,
  lineNumber: number,
  line: string,
  options: SearchOptions,
): string {
  if (options.lineNumber) return `${filePath}:${lineNumber}:${line}`;
  return `${filePath}:${line}`;
}

async function collectSearchTargets(
  vfs: VfsService,
  cwd: string,
  rawTargets: string[],
): Promise<SearchTarget[]> {
  const files = await vfs.exportFiles();
  const targetPaths = rawTargets.length > 0 ? rawTargets : ["."];
  const resolvedTargets = targetPaths.map((target) =>
    resolveVirtualPath(cwd, target),
  );
  const targets: SearchTarget[] = [];

  for (const file of files) {
    if (
      !resolvedTargets.some((target) =>
        virtualPathMatchesTarget(file.path, target),
      )
    ) {
      continue;
    }
    targets.push({
      path: displayVirtualPath(file.path),
      contents: file.bytes.toString("utf-8"),
    });
  }

  return targets.sort((a, b) => a.path.localeCompare(b.path));
}

function virtualPathMatchesTarget(filePath: string, target: string): boolean {
  const normalizedFile = normalizeAbsoluteVirtualPath(filePath);
  const normalizedTarget = normalizeAbsoluteVirtualPath(target);
  return (
    normalizedFile === normalizedTarget ||
    normalizedFile.startsWith(`${normalizedTarget.replace(/\/$/, "")}/`)
  );
}

function displayVirtualPath(virtualPath: string): string {
  return virtualPath.replace(/^\/+/, "") || ".";
}

async function mkdirVirtualPath(
  vfs: VfsService,
  virtualPath: string,
  recursive: boolean,
): Promise<void> {
  const diskPath = vfs.resolveDiskPath(virtualPath);
  await assertNoExistingSymlinkPath(vfs, diskPath);
  await fsp.mkdir(diskPath, { recursive, mode: 0o700 });
}

async function assertNoExistingSymlinkPath(
  vfs: VfsService,
  diskPath: string,
): Promise<void> {
  const relative = path.relative(vfs.filesRoot, diskPath);
  if (!relative) return;

  let current = vfs.filesRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fsp.lstat(current).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in the VFS: ${segment}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${segment}`);
    }
  }
}

function resolveVirtualPath(cwd: string, input: string): string {
  const cleanInput = stripQuotes(input);
  if (!cleanInput || cleanInput === ".") return cwd || "/";
  if (cleanInput.startsWith("/")) return cleanInput;
  return path.posix.normalize(path.posix.join(cwd || "/", cleanInput));
}

function normalizeAbsoluteVirtualPath(input: string): string {
  const normalized = path.posix.normalize(
    input.startsWith("/") ? input : `/${input}`,
  );
  return normalized === "/" ? "/" : normalized.replace(/\/$/, "");
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = re.exec(input);
  while (match) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    match = re.exec(input);
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
