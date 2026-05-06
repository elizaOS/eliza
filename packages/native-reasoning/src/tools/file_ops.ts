/**
 * File / search tool family for the native reasoning loop.
 *
 *   - read_file   — read a UTF-8 text file (offset/limit in lines)
 *   - write_file  — overwrite a file (creates parents)
 *   - edit_file   — str_replace edit; errors if the needle isn't unique
 *   - glob        — fast-glob style pattern search (capped at 200 paths)
 *   - grep        — content search via ripgrep (cap 100 matches with context)
 *
 * All paths are restricted to SHELL_ALLOWED_DIRECTORY (default /workspace).
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { NativeTool, NativeToolHandler } from "../tool-schema.js";
import { getAllowedDir, resolveSafePath, truncate } from "./_safe-path.js";

const READ_BYTE_CAP = 256 * 1024; // 256KB safety net per read
const GLOB_MAX = 200;
const GREP_MAX = 100;

/* ──────────────────────────────────────────────────────────────────── *
 *  read_file                                                            *
 * ──────────────────────────────────────────────────────────────────── */

export interface ReadFileInput {
  path: string;
  offset?: number; // line offset (0-based)
  limit?: number; // max lines
}

export const readFileTool: NativeTool = {
  type: "custom",
  name: "read_file",
  description:
    "Read a UTF-8 text file from the allowed workspace. Optional 0-based " +
    "line offset and limit for paging through large files.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number", description: "0-based line offset" },
      limit: { type: "number", description: "Max number of lines to return" },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const readFileHandler: NativeToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as Partial<ReadFileInput>;
  if (typeof input.path !== "string") {
    return { content: "read_file: 'path' is required", is_error: true };
  }
  let abs: string;
  try {
    abs = resolveSafePath(input.path);
  } catch (err) {
    return { content: `read_file: ${(err as Error).message}`, is_error: true };
  }

  let raw: string;
  try {
    const buf = await fs.readFile(abs);
    // Defensive byte cap before splitting.
    const sliced =
      buf.byteLength > READ_BYTE_CAP ? buf.subarray(0, READ_BYTE_CAP) : buf;
    raw = sliced.toString("utf8");
    if (buf.byteLength > READ_BYTE_CAP) {
      raw += `\n[...truncated ${buf.byteLength - READ_BYTE_CAP} bytes]`;
    }
  } catch (err) {
    return {
      content: `read_file: ${(err as NodeJS.ErrnoException).message}`,
      is_error: true,
    };
  }

  const wantsPaging =
    typeof input.offset === "number" || typeof input.limit === "number";
  if (!wantsPaging) return { content: raw };

  const lines = raw.split("\n");
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.max(0, input.limit ?? lines.length);
  const slice = lines.slice(offset, offset + limit);
  return { content: slice.join("\n") };
};

/* ──────────────────────────────────────────────────────────────────── *
 *  write_file                                                           *
 * ──────────────────────────────────────────────────────────────────── */

export interface WriteFileInput {
  path: string;
  content: string;
}

export const writeFileTool: NativeTool = {
  type: "custom",
  name: "write_file",
  description:
    "Overwrite (or create) a UTF-8 text file in the allowed workspace. " +
    "Parent directories are created as needed.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

export const writeFileHandler: NativeToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as Partial<WriteFileInput>;
  if (typeof input.path !== "string" || typeof input.content !== "string") {
    return {
      content: "write_file: 'path' and 'content' are required",
      is_error: true,
    };
  }
  let abs: string;
  try {
    abs = resolveSafePath(input.path);
  } catch (err) {
    return { content: `write_file: ${(err as Error).message}`, is_error: true };
  }

  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, "utf8");
  } catch (err) {
    return {
      content: `write_file: ${(err as NodeJS.ErrnoException).message}`,
      is_error: true,
    };
  }
  return {
    content: `wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${abs}`,
  };
};

/* ──────────────────────────────────────────────────────────────────── *
 *  edit_file (str_replace)                                              *
 * ──────────────────────────────────────────────────────────────────── */

export interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
}

export const editFileTool: NativeTool = {
  type: "custom",
  name: "edit_file",
  description:
    "Edit a file by replacing the unique occurrence of `old_string` with " +
    "`new_string`. Errors if `old_string` is missing or appears more than once.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: {
        type: "string",
        description: "The exact text to replace; must match exactly once.",
      },
      new_string: { type: "string", description: "Replacement text." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
};

export const editFileHandler: NativeToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as Partial<EditFileInput>;
  if (
    typeof input.path !== "string" ||
    typeof input.old_string !== "string" ||
    typeof input.new_string !== "string"
  ) {
    return {
      content: "edit_file: 'path', 'old_string', 'new_string' are required",
      is_error: true,
    };
  }
  if (input.old_string.length === 0) {
    return {
      content: "edit_file: 'old_string' must be non-empty",
      is_error: true,
    };
  }
  let abs: string;
  try {
    abs = resolveSafePath(input.path);
  } catch (err) {
    return { content: `edit_file: ${(err as Error).message}`, is_error: true };
  }

  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch (err) {
    return {
      content: `edit_file: ${(err as NodeJS.ErrnoException).message}`,
      is_error: true,
    };
  }

  const idx = content.indexOf(input.old_string);
  if (idx < 0) {
    return {
      content: `edit_file: 'old_string' not found in ${abs}`,
      is_error: true,
    };
  }
  const next = content.indexOf(input.old_string, idx + input.old_string.length);
  if (next >= 0) {
    return {
      content: `edit_file: 'old_string' is not unique in ${abs} (found ≥2 matches)`,
      is_error: true,
    };
  }

  const updated =
    content.slice(0, idx) +
    input.new_string +
    content.slice(idx + input.old_string.length);
  try {
    await fs.writeFile(abs, updated, "utf8");
  } catch (err) {
    return {
      content: `edit_file: ${(err as NodeJS.ErrnoException).message}`,
      is_error: true,
    };
  }
  return { content: `edited ${abs}` };
};

/* ──────────────────────────────────────────────────────────────────── *
 *  glob                                                                 *
 * ──────────────────────────────────────────────────────────────────── */

export interface GlobInput {
  pattern: string;
  cwd?: string;
}

export const globTool: NativeTool = {
  type: "custom",
  name: "glob",
  description:
    "List files matching a glob pattern (e.g. '**/*.ts'). Returns up to 200 paths " +
    "relative to `cwd` (defaults to the workspace root).",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      cwd: { type: "string" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export const globHandler: NativeToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as Partial<GlobInput>;
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    return { content: "glob: 'pattern' is required", is_error: true };
  }
  let cwd: string;
  try {
    cwd = input.cwd ? resolveSafePath(input.cwd) : getAllowedDir();
  } catch (err) {
    return { content: `glob: ${(err as Error).message}`, is_error: true };
  }

  let results: string[];
  try {
    results = await runGlob(input.pattern, cwd);
  } catch (err) {
    return { content: `glob: ${(err as Error).message}`, is_error: true };
  }

  const limited = results.slice(0, GLOB_MAX);
  const tail =
    results.length > GLOB_MAX
      ? `\n[...truncated ${results.length - GLOB_MAX} more]`
      : "";
  if (limited.length === 0) return { content: "(no matches)" };
  return { content: `${limited.join("\n")}${tail}` };
};

async function runGlob(pattern: string, cwd: string): Promise<string[]> {
  // Try fast-glob if installed; fall back to a hand-rolled walker.
  try {
    // Dynamic import keeps it optional.
    // @ts-expect-error fast-glob is an optional runtime dep; fallback walker handles absence
    const fg = (await import("fast-glob")).default as
      | undefined
      | ((p: string, o: object) => Promise<string[]>);
    if (fg) {
      return await fg(pattern, {
        cwd,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
      });
    }
  } catch {
    /* fall through */
  }
  return await nativeGlob(pattern, cwd);
}

/** Tiny fallback: supports `**`, `*`, `?` only — no brace/extglob. */
async function nativeGlob(pattern: string, cwd: string): Promise<string[]> {
  const re = globToRegExp(pattern);
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && out.length < GLOB_MAX * 2) {
    const rel = stack.pop()!;
    const abs = path.join(cwd, rel);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === ".git" || ent.name === "node_modules") continue;
        stack.push(childRel);
      } else if (ent.isFile() && re.test(childRel)) {
        out.push(childRel);
      }
    }
  }
  return out.sort();
}

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (pattern[i] === "/") i += 1;
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if ("\\^$+(){}[]|.".includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

/* ──────────────────────────────────────────────────────────────────── *
 *  grep                                                                 *
 * ──────────────────────────────────────────────────────────────────── */

export interface GrepInput {
  pattern: string;
  path?: string;
  context?: number;
}

export const grepTool: NativeTool = {
  type: "custom",
  name: "grep",
  description:
    "Search file contents (regex) inside the allowed workspace. Returns up to " +
    "100 matches with surrounding line context.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: {
        type: "string",
        description: "Subdirectory to search (default: workspace root).",
      },
      context: {
        type: "number",
        description: "Context lines around each match (default 2).",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

export const grepHandler: NativeToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as Partial<GrepInput>;
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    return { content: "grep: 'pattern' is required", is_error: true };
  }
  let cwd: string;
  try {
    cwd = input.path ? resolveSafePath(input.path) : getAllowedDir();
  } catch (err) {
    return { content: `grep: ${(err as Error).message}`, is_error: true };
  }

  const ctxN = Math.max(0, Math.min(10, input.context ?? 2));

  const out = await runGrep(input.pattern, cwd, ctxN);
  if (out.error && out.lines.length === 0) {
    return { content: `grep: ${out.error}`, is_error: true };
  }
  if (out.lines.length === 0) {
    return { content: "(no matches)" };
  }
  const text = out.lines.join("\n");
  const { text: capped } = truncate(text, 64 * 1024);
  return { content: capped };
};

interface GrepOut {
  lines: string[];
  error?: string;
}

async function runGrep(
  pattern: string,
  cwd: string,
  ctxN: number,
): Promise<GrepOut> {
  try {
    return await runRipgrep(pattern, cwd, ctxN);
  } catch {
    return await runNativeGrep(pattern, cwd, ctxN);
  }
}

function runRipgrep(
  pattern: string,
  cwd: string,
  ctxN: number,
): Promise<GrepOut> {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-heading",
      "--line-number",
      "--with-filename",
      "--color",
      "never",
      "-C",
      String(ctxN),
      "-e",
      pattern,
      ".",
    ];
    const child = spawn("rg", args, { cwd });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let killed = false;
    child.stdout.on("data", (b) => {
      if (killed) return;
      stdout += b.toString("utf8");
      bytes += b.length;
      if (bytes > 256 * 1024) {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0 && code !== 1 && !killed) {
        return reject(new Error(stderr || `ripgrep exit ${code}`));
      }
      const matches = capMatches(
        stdout.split("\n").filter(Boolean),
        GREP_MAX,
        ctxN,
      );
      resolve({ lines: matches });
    });
  });
}

/** Cap by *match* count, treating `--` as separator between match groups. */
function capMatches(lines: string[], cap: number, ctxN: number): string[] {
  if (ctxN === 0) return lines.slice(0, cap);
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const ln of lines) {
    if (ln === "--") {
      if (cur.length) groups.push(cur);
      cur = [];
    } else {
      cur.push(ln);
    }
  }
  if (cur.length) groups.push(cur);
  const kept = groups.slice(0, cap);
  return kept.flatMap((g, i) => (i === 0 ? g : ["--", ...g]));
}

async function runNativeGrep(
  pattern: string,
  cwd: string,
  ctxN: number,
): Promise<GrepOut> {
  const re = new RegExp(pattern);
  const out: string[] = [];
  const stack: string[] = [""];
  let matches = 0;
  while (stack.length > 0 && matches < GREP_MAX) {
    const rel = stack.pop()!;
    const abs = path.join(cwd, rel);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === ".git" || ent.name === "node_modules") continue;
        stack.push(childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      let txt: string;
      try {
        txt = await fs.readFile(path.join(cwd, childRel), "utf8");
      } catch {
        continue;
      }
      const lines = txt.split("\n");
      for (let i = 0; i < lines.length && matches < GREP_MAX; i++) {
        if (!re.test(lines[i])) continue;
        const start = Math.max(0, i - ctxN);
        const end = Math.min(lines.length, i + ctxN + 1);
        if (out.length) out.push("--");
        for (let j = start; j < end; j++) {
          out.push(`${childRel}:${j + 1}:${lines[j]}`);
        }
        matches += 1;
      }
    }
  }
  return { lines: out };
}
