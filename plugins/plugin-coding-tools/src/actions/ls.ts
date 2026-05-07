import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger as coreLogger,
} from "@elizaos/core";

import {
  failureToActionResult,
  readArrayParam,
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

const ENTRY_LIMIT = 1000;

type EntryType = "file" | "dir" | "symlink";

interface LsEntry {
  name: string;
  type: EntryType;
  size?: number;
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

export const lsAction: Action = {
  name: "LS",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  similes: ["LIST_DIR", "DIR"],
  description:
    "List entries in a directory, sorted with directories first then files. Each directory name has a trailing '/'. Pass an `ignore` array of glob patterns to skip entries. Use this instead of BASH for directory listing.",
  descriptionCompressed:
    "List a directory; dirs first, files second; supports ignore globs.",
  parameters: [
    {
      name: "path",
      description: "Absolute path of the directory to list. Defaults to the session cwd.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "ignore",
      description: "Array of glob patterns to exclude (e.g. ['*.log', 'tmp/*']).",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
  ],
  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    const d = runtime.getSetting?.("CODING_TOOLS_DISABLE");
    if (d === true || d === "true" || d === "1") return false;
    return true;
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
      return failureToActionResult({ reason: "missing_param", message: "no roomId" });
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
        validation.reason === "outside_roots"
          ? "path_outside_roots"
          : validation.reason === "blocked"
            ? "path_blocked"
            : validation.reason === "not_absolute"
              ? "invalid_param"
              : "invalid_param";
      return failureToActionResult({ reason, message: validation.message });
    }
    const dir = validation.resolved;

    const ignoreRaw = readArrayParam(options, "ignore");
    const ignoreMatchers: RegExp[] = (ignoreRaw ?? [])
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .map((entry) => globToRegExp(entry));

    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult({ reason: "io_error", message: `readdir failed: ${msg}` });
    }

    const filteredNames = names.filter(
      (name) => !ignoreMatchers.some((re) => re.test(name)),
    );

    const totalAfterIgnore = filteredNames.length;
    const truncated = totalAfterIgnore > ENTRY_LIMIT;
    const limited = filteredNames.slice(0, ENTRY_LIMIT);

    const enriched: LsEntry[] = [];
    for (const name of limited) {
      const joined = path.join(dir, name);
      let type: EntryType = "file";
      let size: number | undefined;
      try {
        const st = await fs.lstat(joined);
        if (st.isDirectory()) {
          type = "dir";
        } else if (st.isSymbolicLink()) {
          type = "symlink";
        } else if (st.isFile()) {
          type = "file";
          size = st.size;
        }
      } catch {
        // unreadable entry — fall through with default type
      }
      enriched.push(size === undefined ? { name, type } : { name, type, size });
    }

    const dirEntries = enriched
      .filter((e) => e.type === "dir")
      .sort((a, b) => a.name.localeCompare(b.name));
    const fileEntries = enriched
      .filter((e) => e.type !== "dir")
      .sort((a, b) => a.name.localeCompare(b.name));
    const sorted: LsEntry[] = [...dirEntries, ...fileEntries];

    const lines = [
      `Directory: ${dir}`,
      ...sorted.map((e) => (e.type === "dir" ? `${e.name}/` : e.name)),
    ];
    if (truncated) {
      lines.push(`…[truncated, listed ${ENTRY_LIMIT} of ${totalAfterIgnore} entries]`);
    }
    const text = lines.join("\n");

    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} LS dir=${dir} count=${sorted.length} truncated=${truncated}`,
    );

    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, {
      entries: sorted,
      truncated,
    });
  },
};
