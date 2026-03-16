import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { JsonValue } from "../../types.js";
import type { SubAgentTool, ToolResult } from "./types.js";

const execAsync = promisify(exec);

/**
 * Create tools for sub-agent execution
 */
export function createTools(cwd: string): SubAgentTool[] {
  return [
    {
      name: "read_file",
      description: "Read the contents of a file",
      parameters: [
        { name: "filepath", description: "Path to file", required: true },
      ],
      execute: async (args) => readFile(cwd, args.filepath ?? ""),
    },
    {
      name: "write_file",
      description: "Create or overwrite a file",
      parameters: [
        { name: "filepath", description: "Path to file", required: true },
        { name: "content", description: "File content", required: true },
      ],
      execute: async (args) =>
        writeFile(cwd, args.filepath ?? "", args.content ?? ""),
    },
    {
      name: "edit_file",
      description: "Edit a file by replacing text",
      parameters: [
        { name: "filepath", description: "Path to file", required: true },
        { name: "old_str", description: "Text to find", required: true },
        {
          name: "new_str",
          description: "Text to replace with",
          required: true,
        },
      ],
      execute: async (args) =>
        editFile(
          cwd,
          args.filepath ?? "",
          args.old_str ?? "",
          args.new_str ?? "",
        ),
    },
    {
      name: "list_files",
      description: "List files in a directory",
      parameters: [
        { name: "path", description: "Directory path", required: false },
      ],
      execute: async (args) => listFiles(cwd, args.path ?? "."),
    },
    {
      name: "search_files",
      description: "Search for a string across files (case-insensitive)",
      parameters: [
        { name: "pattern", description: "Text to search for", required: true },
        {
          name: "path",
          description: "Directory to search (default: .)",
          required: false,
        },
        {
          name: "max_matches",
          description: "Max matches (default: 50)",
          required: false,
        },
      ],
      execute: async (args) =>
        searchFiles(
          cwd,
          args.pattern ?? "",
          args.path ?? ".",
          args.max_matches ?? "",
        ),
    },
    {
      name: "shell",
      description: "Execute a shell command",
      parameters: [
        { name: "command", description: "Command to run", required: true },
      ],
      execute: async (args) => executeShell(cwd, args.command ?? ""),
    },
  ];
}

async function readFile(cwd: string, filepath: string): Promise<ToolResult> {
  try {
    const fullPath = path.resolve(cwd, filepath);
    const content = await fs.readFile(fullPath, "utf-8");
    const truncated =
      content.length > 5000
        ? `${content.substring(0, 5000)}\n...(truncated)`
        : content;
    return {
      success: true,
      output: `File ${filepath} (${content.length} chars):\n${truncated}`,
      data: { filepath, size: content.length },
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    return {
      success: false,
      output: `Error reading ${filepath}: ${error.code === "ENOENT" ? "File not found" : error.message}`,
    };
  }
}

async function writeFile(
  cwd: string,
  filepath: string,
  content: string,
): Promise<ToolResult> {
  try {
    const fullPath = path.resolve(cwd, filepath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return {
      success: true,
      output: `Created/wrote ${filepath} (${content.length} chars)`,
      data: { filepath, size: content.length },
    };
  } catch (err) {
    return {
      success: false,
      output: `Error writing ${filepath}: ${(err as Error).message}`,
    };
  }
}

async function editFile(
  cwd: string,
  filepath: string,
  oldStr: string,
  newStr: string,
): Promise<ToolResult> {
  try {
    const fullPath = path.resolve(cwd, filepath);
    const content = await fs.readFile(fullPath, "utf-8");

    if (!content.includes(oldStr)) {
      return {
        success: false,
        output: `Could not find the specified text in ${filepath}`,
      };
    }

    const newContent = content.replace(oldStr, newStr);
    await fs.writeFile(fullPath, newContent, "utf-8");
    return {
      success: true,
      output: `Edited ${filepath}: replaced ${oldStr.length} chars with ${newStr.length} chars`,
      data: { filepath },
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    return {
      success: false,
      output: `Error editing ${filepath}: ${error.code === "ENOENT" ? "File not found" : error.message}`,
    };
  }
}

async function listFiles(cwd: string, dirPath: string): Promise<ToolResult> {
  try {
    const fullPath = path.resolve(cwd, dirPath);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const items = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
      .join("\n");
    return {
      success: true,
      output: `Contents of ${dirPath}:\n${items}`,
      data: { path: dirPath, count: entries.length },
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    return {
      success: false,
      output: `Error listing ${dirPath}: ${error.code === "ENOENT" ? "Directory not found" : error.message}`,
    };
  }
}

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
]);

const DEFAULT_TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".txt",
  ".html",
  ".css",
  ".scss",
  ".yaml",
  ".yml",
  ".toml",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".sh",
  ".bash",
  ".zsh",
  ".env",
]);

async function searchFiles(
  cwd: string,
  pattern: string,
  dirPath: string,
  maxMatchesRaw: string,
): Promise<ToolResult> {
  const needle = pattern.trim();
  if (!needle) {
    return { success: false, output: "Missing pattern for search_files" };
  }

  const parsedMax = Number.parseInt(maxMatchesRaw, 10);
  const maxMatches =
    Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 50;

  const fullPath = path.resolve(cwd, dirPath);
  const matches: SearchMatch[] = [];

  await searchInDirectory(fullPath, needle, matches, maxMatches, cwd);

  if (matches.length === 0) {
    return {
      success: true,
      output: `No matches for "${needle}"`,
      data: { pattern: needle, matches: [], count: 0, path: dirPath },
    };
  }

  const byFile = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const list = byFile.get(m.file) ?? [];
    list.push(m);
    byFile.set(m.file, list);
  }

  const lines: string[] = [];
  lines.push(
    `Search "${needle}" (${matches.length} match(es) in ${byFile.size} file(s))`,
  );
  for (const [file, fileMatches] of byFile) {
    lines.push(file);
    for (const m of fileMatches.slice(0, 8)) {
      lines.push(`  L${m.line}: ${m.content}`);
    }
    if (fileMatches.length > 8) {
      lines.push(`  … +${fileMatches.length - 8} more`);
    }
  }

  return {
    success: true,
    output: lines.join("\n"),
    data: {
      pattern: needle,
      matches: matches.map((m) => ({
        file: m.file,
        line: m.line,
        content: m.content,
      })) as JsonValue,
      count: matches.length,
      path: dirPath,
    },
  };
}

async function searchInDirectory(
  dir: string,
  needle: string,
  matches: SearchMatch[],
  maxMatches: number,
  cwd: string,
): Promise<void> {
  if (matches.length >= maxMatches) return;

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (matches.length >= maxMatches) break;
    if (entry.name.startsWith(".")) continue;
    if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await searchInDirectory(fullPath, needle, matches, maxMatches, cwd);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!DEFAULT_TEXT_EXTENSIONS.has(ext) && entry.name.includes(".")) continue;

    const content = await fs.readFile(fullPath, "utf-8");

    const lines = content.split("\n");
    const needleLower = needle.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxMatches) break;
      const line = lines[i] ?? "";
      if (!line.toLowerCase().includes(needleLower)) continue;
      matches.push({
        file: path.relative(cwd, fullPath),
        line: i + 1,
        content: line.trim().substring(0, 200),
      });
    }
  }
}

async function executeShell(cwd: string, command: string): Promise<ToolResult> {
  // Block dangerous commands
  const blocked = ["rm -rf /", "rm -rf ~", "sudo rm", "mkfs", "dd if=/dev"];
  if (blocked.some((b) => command.toLowerCase().includes(b))) {
    return { success: false, output: `Blocked dangerous command: ${command}` };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const output = `$ ${command}\n${stdout}${stderr ? `\nstderr: ${stderr}` : ""}`;
    return {
      success: true,
      output: output.substring(0, 3000),
      data: { command, exitCode: 0 },
    };
  } catch (err) {
    const error = err as Error & { stderr?: string; code?: number };
    const exitCode = typeof error.code === "number" ? error.code : null;
    return {
      success: false,
      output:
        `Command failed: ${command}\n${error.stderr || error.message}`.substring(
          0,
          1000,
        ),
      data: { command, exitCode },
    };
  }
}

/**
 * Parse tool calls from LLM response
 * Format: TOOL: tool_name(arg1="value1", arg2="value2")
 */
export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const pattern = /TOOL:\s*(\w+)\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    const start = match.index + match[0].length;
    const end = findMatchingParen(text, start);
    if (end === -1) continue;

    const argsStr = text.substring(start, end);
    const args = parseArgs(argsStr);

    // Handle write_file content from code blocks
    if (name === "write_file" || name === "writefile") {
      const afterTool = text.substring(match.index);
      const contentMatch =
        afterTool.match(/CONTENT_START\n?([\s\S]*?)\n?CONTENT_END/) ||
        afterTool.match(/```[\w]*\n?([\s\S]*?)```/);
      if (contentMatch && contentMatch[1].length > 10) {
        args.content = contentMatch[1];
      }
    }

    calls.push({ name, args });
  }

  return calls;
}

function findMatchingParen(text: string, start: number): number {
  let depth = 1;
  let inString = false;
  let stringChar = "";

  for (let i = start; i < text.length && depth > 0; i++) {
    const char = text[i];
    const prev = i > 0 ? text[i - 1] : "";

    if (inString) {
      if (char === stringChar && prev !== "\\") inString = false;
    } else {
      if (char === '"' || char === "'" || char === "`") {
        inString = true;
        stringChar = char;
      } else if (char === "(") {
        depth++;
      } else if (char === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

function parseArgs(argsStr: string): Record<string, string> {
  const args: Record<string, string> = {};
  const pattern = /(\w+)\s*=\s*["'`]([^"'`]*)["'`]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(argsStr)) !== null) {
    args[match[1]] = match[2].replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }

  return args;
}
