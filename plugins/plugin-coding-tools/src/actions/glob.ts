import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type Action,
  type ActionResult,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import type { SandboxService } from "../services/sandbox-service.js";
import type { SessionCwdService } from "../services/session-cwd-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";

const RESULT_LIMIT = 100;
const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".turbo",
  ".cache",
]);

interface NodeFsGlobModule {
  glob: (
    pattern: string | string[],
    options?: { cwd?: string; exclude?: (path: string) => boolean },
  ) => AsyncIterable<string>;
}

function getNodeFsGlob(): NodeFsGlobModule["glob"] | undefined {
  const candidate = (fs as Partial<NodeFsGlobModule>).glob;
  return typeof candidate === "function" ? candidate : undefined;
}

function globToRegExp(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const after = pattern[i + 2];
        if (after === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if (ch === ".") {
      regex += "\\.";
      i += 1;
    } else if ("+^$()|[]{}\\".includes(ch ?? "")) {
      regex += `\\${ch}`;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}

async function walkFallback(root: string, pattern: string): Promise<string[]> {
  const matcher = globToRegExp(pattern);
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (EXCLUDED_DIR_NAMES.has(name)) continue;
      const abs = path.join(dir, name);
      try {
        const st = await fs.lstat(abs);
        if (st.isDirectory()) {
          await walk(abs);
        } else if (st.isFile()) {
          const rel = path.relative(root, abs).split(path.sep).join("/");
          if (matcher.test(rel)) {
            results.push(abs);
          }
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  await walk(root);
  return results;
}

async function nodeGlob(
  glob: NodeFsGlobModule["glob"],
  root: string,
  pattern: string,
): Promise<string[]> {
  const out: string[] = [];
  const iter = glob(pattern, {
    cwd: root,
    exclude: (p: string) => {
      const segments = p.split(/[\\/]/);
      return segments.some((seg) => EXCLUDED_DIR_NAMES.has(seg));
    },
  });
  for await (const entry of iter) {
    out.push(path.isAbsolute(entry) ? entry : path.join(root, entry));
  }
  return out;
}

export const globAction: Action = {
  name: "GLOB",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: ["FIND_FILES"],
  description:
    "Find files matching a glob pattern (e.g. '**/*.ts'). Returns up to 100 absolute paths sorted by mtime descending. Excludes VCS, build, and dependency directories. Use this instead of BASH for file discovery.",
  descriptionCompressed:
    "Find files by glob (e.g. '**/*.ts'); returns absolute paths sorted by mtime.",
  parameters: [
    {
      name: "pattern",
      description: "Glob pattern relative to the search root (e.g. '**/*.ts').",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "path",
      description:
        "Absolute path of the directory to search. Defaults to the session cwd.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ) => {
    return Boolean(
      runtime.getService(SANDBOX_SERVICE) &&
        runtime.getService(SESSION_CWD_SERVICE),
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const conversationId =
      message.roomId !== undefined && message.roomId !== null
        ? String(message.roomId)
        : undefined;
    if (!conversationId) {
      return failureToActionResult({
        reason: "missing_param",
        message: "no roomId",
      });
    }

    const pattern = readStringParam(options, "pattern");
    if (!pattern || pattern.length === 0) {
      return failureToActionResult({
        reason: "missing_param",
        message: "pattern is required",
      });
    }

    const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
      typeof SandboxService
    > | null;
    const session = runtime.getService(SESSION_CWD_SERVICE) as InstanceType<
      typeof SessionCwdService
    > | null;
    if (!sandbox || !session) {
      return failureToActionResult({
        reason: "internal",
        message: "coding-tools services unavailable",
      });
    }

    const requestedPath = readStringParam(options, "path");
    const targetPath = requestedPath ?? session.getCwd(conversationId);

    const validation = await sandbox.validatePath(conversationId, targetPath);
    if (!validation.ok) {
      const reason =
        validation.reason === "blocked" ? "path_blocked" : "invalid_param";
      return failureToActionResult({ reason, message: validation.message });
    }
    const root = validation.resolved;

    let candidates: string[];
    const builtinGlob = getNodeFsGlob();
    if (builtinGlob) {
      try {
        candidates = await nodeGlob(builtinGlob, root, pattern);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        coreLogger.warn(
          `${CODING_TOOLS_LOG_PREFIX} GLOB node:fs.glob failed (${msg}); falling back to walker`,
        );
        candidates = await walkFallback(root, pattern);
      }
    } else {
      candidates = await walkFallback(root, pattern);
    }

    const stats = await Promise.all(
      candidates.map(async (filePath) => {
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) return undefined;
          return { filePath, mtimeMs: stat.mtimeMs };
        } catch {
          return undefined;
        }
      }),
    );

    const filtered = stats.filter(
      (entry): entry is { filePath: string; mtimeMs: number } =>
        entry !== undefined,
    );
    filtered.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const truncated = filtered.length > RESULT_LIMIT;
    const limited = filtered
      .slice(0, RESULT_LIMIT)
      .map((entry) => entry.filePath);

    const header = `${limited.length} files (truncated=${truncated})`;
    const text =
      limited.length === 0 ? header : `${header}\n${limited.join("\n")}`;

    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} GLOB pattern=${JSON.stringify(pattern)} root=${root} found=${limited.length} truncated=${truncated}`,
    );

    if (callback) await callback({ text });

    return successActionResult(text, {
      files: limited,
      truncated,
    });
  },
};
