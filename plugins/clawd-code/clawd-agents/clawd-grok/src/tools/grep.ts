import { stat } from "fs/promises";
import path from "path";
import { ripgrep } from "ripgrep";
import type { ToolResult } from "../types/index";

const MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 2000;

interface GrepParams {
  pattern: string;
  path?: string;
  include?: string;
}

interface RipgrepMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    absolute_offset: number;
    submatches: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

function buildArgs(params: GrepParams): string[] {
  const args = ["--json", "--hidden", "--glob=!.git/*", "--no-messages"];

  if (params.include) {
    args.push(`--glob=${params.include}`);
  }

  args.push("--", params.pattern, params.path ?? ".");
  return args;
}

function cleanEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.RIPGREP_CONFIG_PATH;
  return env;
}

function cleanPath(file: string): string {
  return path.normalize(file.replace(/^\.[\\/]/, ""));
}

function parseMatches(stdout: string): RipgrepMatch["data"][] {
  if (!stdout.trim()) return [];

  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "match") {
          return [
            {
              ...parsed.data,
              path: { ...parsed.data.path, text: cleanPath(parsed.data.path.text) },
            },
          ];
        }
      } catch {
        // skip malformed lines
      }
      return [];
    });
}

async function getFileMtimes(files: string[], cwd: string): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  await Promise.all(
    files.map(async (file) => {
      const fullPath = path.isAbsolute(file) ? file : path.join(cwd, file);
      try {
        const info = await stat(fullPath);
        times.set(file, info.mtimeMs);
      } catch {
        // skip inaccessible files
      }
    }),
  );
  return times;
}

export async function executeGrep(params: GrepParams, cwd: string): Promise<ToolResult> {
  if (!params.pattern) {
    return { success: false, error: "pattern is required" };
  }

  const searchPath = params.path ? (path.isAbsolute(params.path) ? params.path : path.join(cwd, params.path)) : cwd;

  let searchCwd: string;
  let searchTarget: string | undefined;
  try {
    const info = await stat(searchPath);
    if (info.isDirectory()) {
      searchCwd = searchPath;
    } else {
      searchCwd = path.dirname(searchPath);
      searchTarget = path.relative(searchCwd, searchPath);
    }
  } catch {
    searchCwd = cwd;
    searchTarget = params.path;
  }

  const args = buildArgs({ ...params, path: searchTarget });

  try {
    const result = await ripgrep(args, {
      buffer: true,
      env: cleanEnv(),
      preopens: { ".": searchCwd },
    });

    const stdout = (result.stdout as string) ?? "";
    const code = result.code ?? 1;

    if (code !== 0 && code !== 1 && code !== 2) {
      const stderr = (result.stderr as string) ?? "";
      return { success: false, error: stderr.trim() || `ripgrep failed with code ${code}` };
    }

    if (code === 1) {
      return { success: true, output: "No matches found." };
    }

    const matches = parseMatches(stdout);
    if (matches.length === 0) {
      const msg = code === 2 ? "No matches found.\n(Some paths were inaccessible and skipped)" : "No matches found.";
      return { success: true, output: msg };
    }

    const rebase = (file: string) => path.relative(cwd, path.resolve(searchCwd, file));

    const uniqueFiles = [...new Set(matches.map((m) => rebase(m.path.text)))];
    const mtimes = await getFileMtimes(uniqueFiles, cwd);

    const rows = matches
      .map((m) => ({
        file: rebase(m.path.text),
        line: m.line_number,
        text: m.lines.text.replace(/\n$/, ""),
        mtime: mtimes.get(rebase(m.path.text)) ?? 0,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    const total = rows.length;
    const truncated = total > MAX_MATCHES;
    const display = truncated ? rows.slice(0, MAX_MATCHES) : rows;

    const output: string[] = [`Found ${total} matches${truncated ? ` (showing first ${MAX_MATCHES})` : ""}`];

    let currentFile = "";
    for (const row of display) {
      if (currentFile !== row.file) {
        if (currentFile !== "") output.push("");
        currentFile = row.file;
        output.push(`${row.file}:`);
      }
      const text = row.text.length > MAX_LINE_LENGTH ? `${row.text.substring(0, MAX_LINE_LENGTH)}...` : row.text;
      output.push(`  Line ${row.line}: ${text}`);
    }

    if (truncated) {
      output.push("");
      output.push(
        `(Results truncated: showing ${MAX_MATCHES} of ${total} matches. Consider using a more specific path or pattern.)`,
      );
    }

    if (code === 2) {
      output.push("");
      output.push("(Some paths were inaccessible and skipped)");
    }

    return { success: true, output: output.join("\n") };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Grep failed: ${msg}` };
  }
}
