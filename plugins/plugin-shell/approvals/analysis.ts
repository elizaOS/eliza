/**
 * Command Analysis
 *
 * Functions for analyzing shell commands for security evaluation.
 * Parses commands, resolves executables, and evaluates against allowlists.
 */

import fs from "node:fs";
import path from "node:path";
import { matchAllowlist } from "./allowlist";
import type {
  CommandResolution,
  ExecAllowlistAnalysis,
  ExecAllowlistEntry,
  ExecAllowlistEvaluation,
  ExecCommandAnalysis,
  ExecCommandSegment,
} from "./types";
import { DEFAULT_SAFE_BINS } from "./types";

/**
 * Disallowed tokens in pipeline commands
 */
const DISALLOWED_PIPELINE_TOKENS = new Set([">", "<", "`", "\n", "\r", "(", ")"]);

/**
 * Escape characters inside double quotes
 */
const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`", "\n", "\r"]);

/**
 * Windows-specific unsupported tokens
 */
const WINDOWS_UNSUPPORTED_TOKENS = new Set([
  "&",
  "|",
  "<",
  ">",
  "^",
  "(",
  ")",
  "%",
  "!",
  "\n",
  "\r",
]);

/**
 * Check if next char is a double-quote escape
 */
function isDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}

/**
 * Check if a file is executable
 */
function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Expand home directory
 */
function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return require("node:os").homedir();
  if (value.startsWith("~/")) return path.join(require("node:os").homedir(), value.slice(2));
  return value;
}

/**
 * Parse the first token from a command string
 */
function parseFirstToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const end = trimmed.indexOf(first, 1);
    if (end > 1) return trimmed.slice(1, end);
    return trimmed.slice(1);
  }

  const match = /^[^\s]+/.exec(trimmed);
  return match ? match[0] : null;
}

/**
 * Resolve executable path from PATH
 */
function resolveExecutablePath(
  rawExecutable: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv
): string | undefined {
  const expanded = rawExecutable.startsWith("~") ? expandHome(rawExecutable) : rawExecutable;

  if (expanded.includes("/") || expanded.includes("\\")) {
    if (path.isAbsolute(expanded)) {
      return isExecutableFile(expanded) ? expanded : undefined;
    }
    const base = cwd?.trim() || process.cwd();
    const candidate = path.resolve(base, expanded);
    return isExecutableFile(candidate) ? candidate : undefined;
  }

  const envPath = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const entries = envPath.split(path.delimiter).filter(Boolean);
  const hasExtension = process.platform === "win32" && path.extname(expanded).length > 0;

  const extensions =
    process.platform === "win32"
      ? hasExtension
        ? [""]
        : (
            env?.PATHEXT ??
            env?.Pathext ??
            process.env.PATHEXT ??
            process.env.Pathext ??
            ".EXE;.CMD;.BAT;.COM"
          )
            .split(";")
            .map((ext) => ext.toLowerCase())
      : [""];

  for (const entry of entries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, expanded + ext);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

/**
 * Resolve command to executable info
 */
export function resolveCommandResolution(
  command: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv
): CommandResolution | null {
  const rawExecutable = parseFirstToken(command);
  if (!rawExecutable) return null;

  const resolvedPath = resolveExecutablePath(rawExecutable, cwd, env);
  const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;

  return { rawExecutable, resolvedPath, executableName };
}

/**
 * Resolve command from argv
 */
export function resolveCommandFromArgv(
  argv: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv
): CommandResolution | null {
  const rawExecutable = argv[0]?.trim();
  if (!rawExecutable) return null;

  const resolvedPath = resolveExecutablePath(rawExecutable, cwd, env);
  const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;

  return { rawExecutable, resolvedPath, executableName };
}

/**
 * Iterator action types
 */
type IteratorAction = "split" | "skip" | "include" | { reject: string };

/**
 * Iterate through command while respecting shell quoting
 */
function iterateQuoteAware(
  command: string,
  onChar: (ch: string, next: string | undefined, index: number) => IteratorAction
): { ok: true; parts: string[]; hasSplit: boolean } | { ok: false; reason: string } {
  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let hasSplit = false;

  const pushPart = () => {
    const trimmed = buf.trim();
    if (trimmed) parts.push(trimmed);
    buf = "";
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }

    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      buf += ch;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      buf += ch;
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += ch;
        buf += next;
        i += 1;
        continue;
      }
      if (ch === "$" && next === "(") {
        return { ok: false, reason: "unsupported shell token: $()" };
      }
      if (ch === "`") {
        return { ok: false, reason: "unsupported shell token: `" };
      }
      if (ch === "\n" || ch === "\r") {
        return { ok: false, reason: "unsupported shell token: newline" };
      }
      if (ch === '"') inDouble = false;
      buf += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }

    const action = onChar(ch, next, i);
    if (typeof action === "object" && "reject" in action) {
      return { ok: false, reason: action.reject };
    }
    if (action === "split") {
      pushPart();
      hasSplit = true;
      continue;
    }
    if (action === "skip") continue;
    buf += ch;
  }

  if (escaped || inSingle || inDouble) {
    return { ok: false, reason: "unterminated shell quote/escape" };
  }

  pushPart();
  return { ok: true, parts, hasSplit };
}

/**
 * Split command by pipeline operators
 */
function splitShellPipeline(command: string): {
  ok: boolean;
  reason?: string;
  segments: string[];
} {
  let emptySegment = false;

  const result = iterateQuoteAware(command, (ch, next) => {
    if (ch === "|" && next === "|") {
      return { reject: "unsupported shell token: ||" };
    }
    if (ch === "|" && next === "&") {
      return { reject: "unsupported shell token: |&" };
    }
    if (ch === "|") {
      emptySegment = true;
      return "split";
    }
    if (ch === "&" || ch === ";") {
      return { reject: `unsupported shell token: ${ch}` };
    }
    if (DISALLOWED_PIPELINE_TOKENS.has(ch)) {
      return { reject: `unsupported shell token: ${ch}` };
    }
    if (ch === "$" && next === "(") {
      return { reject: "unsupported shell token: $()" };
    }
    emptySegment = false;
    return "include";
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason, segments: [] };
  }
  if (emptySegment || result.parts.length === 0) {
    return {
      ok: false,
      reason: result.parts.length === 0 ? "empty command" : "empty pipeline segment",
      segments: [],
    };
  }

  return { ok: true, segments: result.parts };
}

/**
 * Tokenize shell segment into argv
 */
function tokenizeShellSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushToken = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }

    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else buf += ch;
      continue;
    }

    if (inDouble) {
      const next = segment[i + 1];
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += next;
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      else buf += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }

    buf += ch;
  }

  if (escaped || inSingle || inDouble) return null;
  pushToken();
  return tokens;
}

/**
 * Parse segments from parts
 */
function parseSegmentsFromParts(
  parts: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv
): ExecCommandSegment[] | null {
  const segments: ExecCommandSegment[] = [];

  for (const raw of parts) {
    const argv = tokenizeShellSegment(raw);
    if (!argv || argv.length === 0) return null;

    segments.push({
      raw,
      argv,
      resolution: resolveCommandFromArgv(argv, cwd, env),
    });
  }

  return segments;
}

/**
 * Check if running on Windows
 */
function isWindowsPlatform(platform?: string | null): boolean {
  const normalized = String(platform ?? "")
    .trim()
    .toLowerCase();
  return normalized.startsWith("win");
}

/**
 * Analyze a shell command
 */
export function analyzeShellCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): ExecCommandAnalysis {
  if (isWindowsPlatform(params.platform)) {
    return analyzeWindowsCommand(params);
  }

  // Try splitting by chain operators
  const chainParts = splitCommandChain(params.command);
  if (chainParts) {
    const chains: ExecCommandSegment[][] = [];
    const allSegments: ExecCommandSegment[] = [];

    for (const part of chainParts) {
      const pipelineSplit = splitShellPipeline(part);
      if (!pipelineSplit.ok) {
        return { ok: false, reason: pipelineSplit.reason, segments: [] };
      }

      const segments = parseSegmentsFromParts(pipelineSplit.segments, params.cwd, params.env);
      if (!segments) {
        return {
          ok: false,
          reason: "unable to parse shell segment",
          segments: [],
        };
      }

      chains.push(segments);
      allSegments.push(...segments);
    }

    return { ok: true, segments: allSegments, chains };
  }

  // No chain operators, parse as simple pipeline
  const split = splitShellPipeline(params.command);
  if (!split.ok) {
    return { ok: false, reason: split.reason, segments: [] };
  }

  const segments = parseSegmentsFromParts(split.segments, params.cwd, params.env);
  if (!segments) {
    return { ok: false, reason: "unable to parse shell segment", segments: [] };
  }

  return { ok: true, segments };
}

/**
 * Analyze Windows command
 */
function analyzeWindowsCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis {
  for (const ch of params.command) {
    if (WINDOWS_UNSUPPORTED_TOKENS.has(ch)) {
      const tokenName = ch === "\n" || ch === "\r" ? "newline" : ch;
      return {
        ok: false,
        reason: `unsupported windows shell token: ${tokenName}`,
        segments: [],
      };
    }
  }

  const argv = tokenizeWindowsSegment(params.command);
  if (!argv || argv.length === 0) {
    return {
      ok: false,
      reason: "unable to parse windows command",
      segments: [],
    };
  }

  return {
    ok: true,
    segments: [
      {
        raw: params.command,
        argv,
        resolution: resolveCommandFromArgv(argv, params.cwd, params.env),
      },
    ],
  };
}

/**
 * Tokenize Windows command segment
 */
function tokenizeWindowsSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inDouble = false;

  const pushToken = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (const ch of segment) {
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inDouble && /\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (inDouble) return null;
  pushToken();
  return tokens.length > 0 ? tokens : null;
}

/**
 * Split command by chain operators (&&, ||, ;)
 */
function splitCommandChain(command: string): string[] | null {
  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let foundChain = false;
  let invalidChain = false;

  const pushPart = () => {
    const trimmed = buf.trim();
    if (trimmed) {
      parts.push(trimmed);
      buf = "";
      return true;
    }
    buf = "";
    return false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }

    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      buf += ch;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      buf += ch;
      continue;
    }

    if (inDouble) {
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += ch;
        buf += next;
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      buf += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }

    if (ch === "&" && next === "&") {
      if (!pushPart()) invalidChain = true;
      i += 1;
      foundChain = true;
      continue;
    }

    if (ch === "|" && next === "|") {
      if (!pushPart()) invalidChain = true;
      i += 1;
      foundChain = true;
      continue;
    }

    if (ch === ";") {
      if (!pushPart()) invalidChain = true;
      foundChain = true;
      continue;
    }

    buf += ch;
  }

  const pushedFinal = pushPart();
  if (!foundChain) return null;
  if (invalidChain || !pushedFinal) return null;
  return parts.length > 0 ? parts : null;
}

/**
 * Normalize safe bins set
 */
export function normalizeSafeBins(entries?: string[]): Set<string> {
  if (!Array.isArray(entries)) return new Set();
  const normalized = entries
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(normalized);
}

/**
 * Resolve safe bins with defaults
 */
export function resolveSafeBins(entries?: string[] | null): Set<string> {
  if (entries === undefined) {
    return normalizeSafeBins([...DEFAULT_SAFE_BINS]);
  }
  return normalizeSafeBins(entries ?? []);
}

/**
 * Check if path-like token
 */
function isPathLikeToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return false;
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) return true;
  if (trimmed.startsWith("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(trimmed);
}

/**
 * Default file existence check
 */
function defaultFileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Check if command is safe bin usage (no file args)
 */
export function isSafeBinUsage(params: {
  argv: string[];
  resolution: CommandResolution | null;
  safeBins: Set<string>;
  cwd?: string;
  fileExists?: (filePath: string) => boolean;
}): boolean {
  if (params.safeBins.size === 0) return false;

  const resolution = params.resolution;
  const execName = resolution?.executableName?.toLowerCase();
  if (!execName) return false;

  const matchesSafeBin =
    params.safeBins.has(execName) ||
    (process.platform === "win32" && params.safeBins.has(path.parse(execName).name));

  if (!matchesSafeBin) return false;
  if (!resolution?.resolvedPath) return false;

  const cwd = params.cwd ?? process.cwd();
  const exists = params.fileExists ?? defaultFileExists;
  const argv = params.argv.slice(1);

  for (const token of argv) {
    if (!token || token === "-") continue;

    if (token.startsWith("-")) {
      const eqIndex = token.indexOf("=");
      if (eqIndex > 0) {
        const value = token.slice(eqIndex + 1);
        if (value && (isPathLikeToken(value) || exists(path.resolve(cwd, value)))) {
          return false;
        }
      }
      continue;
    }

    if (isPathLikeToken(token)) return false;
    if (exists(path.resolve(cwd, token))) return false;
  }

  return true;
}

/**
 * Resolve allowlist candidate path
 */
function resolveAllowlistCandidatePath(
  resolution: CommandResolution | null,
  cwd?: string
): string | undefined {
  if (!resolution) return undefined;
  if (resolution.resolvedPath) return resolution.resolvedPath;

  const raw = resolution.rawExecutable?.trim();
  if (!raw) return undefined;

  const expanded = raw.startsWith("~") ? expandHome(raw) : raw;
  if (!expanded.includes("/") && !expanded.includes("\\")) return undefined;

  if (path.isAbsolute(expanded)) return expanded;

  const base = cwd?.trim() || process.cwd();
  return path.resolve(base, expanded);
}

/**
 * Evaluate segments against allowlist
 */
function evaluateSegments(
  segments: ExecCommandSegment[],
  params: {
    allowlist: ExecAllowlistEntry[];
    safeBins: Set<string>;
    cwd?: string;
    skillBins?: Set<string>;
    autoAllowSkills?: boolean;
  }
): { satisfied: boolean; matches: ExecAllowlistEntry[] } {
  const matches: ExecAllowlistEntry[] = [];
  const allowSkills = params.autoAllowSkills === true && (params.skillBins?.size ?? 0) > 0;

  const satisfied = segments.every((segment) => {
    const candidatePath = resolveAllowlistCandidatePath(segment.resolution, params.cwd);
    const candidateResolution =
      candidatePath && segment.resolution
        ? { ...segment.resolution, resolvedPath: candidatePath }
        : segment.resolution;

    const match = matchAllowlist(params.allowlist, candidateResolution);
    if (match) matches.push(match);

    const safe = isSafeBinUsage({
      argv: segment.argv,
      resolution: segment.resolution,
      safeBins: params.safeBins,
      cwd: params.cwd,
    });

    const skillAllow =
      allowSkills && segment.resolution?.executableName
        ? params.skillBins?.has(segment.resolution.executableName)
        : false;

    return Boolean(match || safe || skillAllow);
  });

  return { satisfied, matches };
}

/**
 * Evaluate command against allowlist
 */
export function evaluateExecAllowlist(params: {
  analysis: ExecCommandAnalysis;
  allowlist: ExecAllowlistEntry[];
  safeBins: Set<string>;
  cwd?: string;
  skillBins?: Set<string>;
  autoAllowSkills?: boolean;
}): ExecAllowlistEvaluation {
  const allowlistMatches: ExecAllowlistEntry[] = [];

  if (!params.analysis.ok || params.analysis.segments.length === 0) {
    return { allowlistSatisfied: false, allowlistMatches };
  }

  // If analysis contains chains, evaluate each separately
  if (params.analysis.chains) {
    for (const chainSegments of params.analysis.chains) {
      const result = evaluateSegments(chainSegments, {
        allowlist: params.allowlist,
        safeBins: params.safeBins,
        cwd: params.cwd,
        skillBins: params.skillBins,
        autoAllowSkills: params.autoAllowSkills,
      });

      if (!result.satisfied) {
        return { allowlistSatisfied: false, allowlistMatches: [] };
      }
      allowlistMatches.push(...result.matches);
    }
    return { allowlistSatisfied: true, allowlistMatches };
  }

  // No chains, evaluate all segments together
  const result = evaluateSegments(params.analysis.segments, {
    allowlist: params.allowlist,
    safeBins: params.safeBins,
    cwd: params.cwd,
    skillBins: params.skillBins,
    autoAllowSkills: params.autoAllowSkills,
  });

  return {
    allowlistSatisfied: result.satisfied,
    allowlistMatches: result.matches,
  };
}

/**
 * Evaluate shell command for allowlist (combined analysis + evaluation)
 */
export function evaluateShellAllowlist(params: {
  command: string;
  allowlist: ExecAllowlistEntry[];
  safeBins: Set<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  skillBins?: Set<string>;
  autoAllowSkills?: boolean;
  platform?: string | null;
}): ExecAllowlistAnalysis {
  const chainParts = isWindowsPlatform(params.platform) ? null : splitCommandChain(params.command);

  if (!chainParts) {
    const analysis = analyzeShellCommand({
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });

    if (!analysis.ok) {
      return {
        analysisOk: false,
        allowlistSatisfied: false,
        allowlistMatches: [],
        segments: [],
      };
    }

    const evaluation = evaluateExecAllowlist({
      analysis,
      allowlist: params.allowlist,
      safeBins: params.safeBins,
      cwd: params.cwd,
      skillBins: params.skillBins,
      autoAllowSkills: params.autoAllowSkills,
    });

    return {
      analysisOk: true,
      allowlistSatisfied: evaluation.allowlistSatisfied,
      allowlistMatches: evaluation.allowlistMatches,
      segments: analysis.segments,
    };
  }

  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segments: ExecCommandSegment[] = [];

  for (const part of chainParts) {
    const analysis = analyzeShellCommand({
      command: part,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });

    if (!analysis.ok) {
      return {
        analysisOk: false,
        allowlistSatisfied: false,
        allowlistMatches: [],
        segments: [],
      };
    }

    segments.push(...analysis.segments);

    const evaluation = evaluateExecAllowlist({
      analysis,
      allowlist: params.allowlist,
      safeBins: params.safeBins,
      cwd: params.cwd,
      skillBins: params.skillBins,
      autoAllowSkills: params.autoAllowSkills,
    });

    allowlistMatches.push(...evaluation.allowlistMatches);

    if (!evaluation.allowlistSatisfied) {
      return {
        analysisOk: true,
        allowlistSatisfied: false,
        allowlistMatches,
        segments,
      };
    }
  }

  return {
    analysisOk: true,
    allowlistSatisfied: true,
    allowlistMatches,
    segments,
  };
}

/**
 * Check if approval is required
 */
export function requiresExecApproval(params: {
  ask: "off" | "on-miss" | "always";
  security: "deny" | "allowlist" | "full";
  analysisOk: boolean;
  allowlistSatisfied: boolean;
}): boolean {
  return (
    params.ask === "always" ||
    (params.ask === "on-miss" &&
      params.security === "allowlist" &&
      (!params.analysisOk || !params.allowlistSatisfied))
  );
}
