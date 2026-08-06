import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";

const MAX_FILE_SIZE = 100 * 1024; // 100 KB

const UNQUOTED_AT_RE = /(?:^|\s)@([\w\-./\\~][\w\-./\\~:]*)/g;
const QUOTED_AT_RE = /(?:^|\s)@"([^"]+)"/g;

export interface AtMentionedFile {
  raw: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export interface ProcessedMentions {
  enhancedMessage: string;
  mentionedFiles: string[];
}

function parseLineRange(raw: string): { filePath: string; startLine?: number; endLine?: number } {
  const hashIdx = raw.lastIndexOf("#");
  if (hashIdx === -1) return { filePath: raw };

  const filePath = raw.slice(0, hashIdx);
  const fragment = raw.slice(hashIdx + 1);
  const rangeMatch = fragment.match(/^L(\d+)(?:-L?(\d+))?$/);
  if (!rangeMatch) return { filePath: raw };

  const startLine = Number.parseInt(rangeMatch[1]!, 10);
  const endLine = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : undefined;
  return { filePath, startLine, endLine };
}

export function extractAtMentionedFiles(text: string): AtMentionedFile[] {
  const mentions: AtMentionedFile[] = [];
  const seen = new Set<string>();

  for (const re of [QUOTED_AT_RE, UNQUOTED_AT_RE]) {
    re.lastIndex = 0;
    while (true) {
      const m = re.exec(text);
      if (m === null) break;
      const raw = m[1]!;
      if (seen.has(raw)) continue;
      seen.add(raw);
      const parsed = parseLineRange(raw);
      mentions.push({ raw, ...parsed });
    }
  }
  return mentions;
}

function resolvePath(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

function readFileContent(
  filePath: string,
  cwd: string,
  startLine?: number,
  endLine?: number,
): { content: string; truncated: boolean; resolvedPath: string } | null {
  const full = resolvePath(filePath, cwd);
  if (!existsSync(full)) return null;

  try {
    const stat = statSync(full);
    if (stat.isDirectory()) return null;

    const raw = readFileSync(full, "utf-8");
    const lines = raw.split("\n");
    const totalLines = lines.length;

    const start = Math.max(0, (startLine ?? 1) - 1);
    const end = Math.min(totalLines, endLine ?? totalLines);
    const slice = lines.slice(start, end);
    const joined = slice.map((line, i) => `${start + i + 1} | ${line}`).join("\n");

    const truncated = raw.length > MAX_FILE_SIZE;
    const content = truncated ? joined.slice(0, MAX_FILE_SIZE) : joined;
    const header = `[${full}: lines ${start + 1}-${end} of ${totalLines}]`;

    return { content: `${header}\n${content}`, truncated, resolvedPath: full };
  } catch {
    return null;
  }
}

export function processAtMentions(text: string, cwd: string): ProcessedMentions {
  const mentions = extractAtMentionedFiles(text);
  if (mentions.length === 0) {
    return { enhancedMessage: text, mentionedFiles: [] };
  }

  const fileBlocks: string[] = [];
  const mentionedFiles: string[] = [];

  for (const mention of mentions) {
    const result = readFileContent(mention.filePath, cwd, mention.startLine, mention.endLine);
    if (!result) continue;

    mentionedFiles.push(result.resolvedPath);
    let block = `<file path="${result.resolvedPath}">\n${result.content}\n</file>`;
    if (result.truncated) {
      block += `\n<!-- Note: ${result.resolvedPath} was truncated (exceeded ${MAX_FILE_SIZE / 1024}KB). Use read_file for the full content. -->`;
    }
    fileBlocks.push(block);
  }

  if (fileBlocks.length === 0) {
    return { enhancedMessage: text, mentionedFiles: [] };
  }

  const attachedBlock = `<attached_files>\n${fileBlocks.join("\n\n")}\n</attached_files>`;
  return {
    enhancedMessage: `${attachedBlock}\n\n${text}`,
    mentionedFiles,
  };
}
