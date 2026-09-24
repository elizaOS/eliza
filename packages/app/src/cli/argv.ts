/**
 * Pre-Commander CLI argument parsing helpers that operate on the raw `argv`
 * (`[node, script, ...args]`). Detects help/version flags, reads flag presence
 * and `--flag value` / `--flag=value` values while honoring the `--` terminator,
 * extracts the positional command path, and normalizes argv so a program name or
 * a `node`/`bun` executable prefix is handled uniformly.
 */
const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-v", "-V", "--version"]);
const FLAG_TERMINATOR = "--";

export function hasHelpOrVersion(argv: string[]): boolean {
  return argv.some((arg) => HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg));
}

export function hasFlag(argv: string[], name: string): boolean {
  const args = argv.slice(2);
  for (const arg of args) {
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === name) {
      return true;
    }
  }
  return false;
}

export function getVerboseFlag(
  argv: string[],
  options?: { includeDebug?: boolean },
): boolean {
  if (hasFlag(argv, "--verbose")) {
    return true;
  }
  if (options?.includeDebug && hasFlag(argv, "--debug")) {
    return true;
  }
  return false;
}

export function getCommandPath(argv: string[], depth = 2): string[] {
  const args = argv.slice(2);
  const path: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    path.push(arg);
    if (path.length >= depth) {
      break;
    }
  }
  return path;
}

export function getPrimaryCommand(argv: string[]): string | null {
  const [primary] = getCommandPath(argv, 1);
  return primary;
}

export function buildParseArgv(params: {
  programName?: string;
  rawArgs?: string[];
  fallbackArgv?: string[];
}): string[] {
  const baseArgv =
    params.rawArgs && params.rawArgs.length > 0
      ? params.rawArgs
      : params.fallbackArgv && params.fallbackArgv.length > 0
        ? params.fallbackArgv
        : process.argv;
  const programName = params.programName ?? "";
  const normalizedArgv =
    programName && baseArgv[0] === programName
      ? baseArgv.slice(1)
      : baseArgv[0]?.endsWith("eliza") || baseArgv[0]?.endsWith("elizaai")
        ? baseArgv.slice(1)
        : baseArgv;
  const executable = (
    normalizedArgv[0]?.split(/[/\\]/).pop() ?? ""
  ).toLowerCase();
  const looksLikeNode =
    normalizedArgv.length >= 2 &&
    (isNodeExecutable(executable) || isBunExecutable(executable));
  if (looksLikeNode) {
    return normalizedArgv;
  }
  return ["node", programName || "eliza", ...normalizedArgv];
}

const nodeExecutablePattern = /^node-\d+(?:\.\d+)*(?:\.exe)?$/;

function isNodeExecutable(executable: string): boolean {
  return (
    executable === "node" ||
    executable === "node.exe" ||
    executable === "nodejs" ||
    executable === "nodejs.exe" ||
    nodeExecutablePattern.test(executable)
  );
}

function isBunExecutable(executable: string): boolean {
  return executable === "bun" || executable === "bun.exe";
}
