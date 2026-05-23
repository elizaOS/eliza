import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type ActionResult,
  CapabilityError,
  type FileListResult,
  getCapabilityRouter,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
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

function sortEntries(entries: LsEntry[]): LsEntry[] {
  const dirEntries = entries
    .filter((e) => e.type === "dir")
    .sort((a, b) => a.name.localeCompare(b.name));
  const fileEntries = entries
    .filter((e) => e.type !== "dir")
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...dirEntries, ...fileEntries];
}

function formatListText(params: {
  dir: string;
  entries: LsEntry[];
  truncated: boolean;
  totalAfterIgnore: number;
}): string {
  const lines = [
    `Directory: ${params.dir}`,
    ...params.entries.map((e) => (e.type === "dir" ? `${e.name}/` : e.name)),
  ];
  if (params.truncated) {
    lines.push(
      `…[truncated, listed ${ENTRY_LIMIT} of ${params.totalAfterIgnore} entries]`,
    );
  }
  return lines.join("\n");
}

function toLsEntry(entry: FileListResult["entries"][number]): LsEntry {
  const type: EntryType =
    entry.kind === "directory"
      ? "dir"
      : entry.kind === "symlink"
        ? "symlink"
        : "file";
  if (type === "file") {
    return { name: entry.name, type, size: entry.size };
  }
  return { name: entry.name, type };
}

async function listWithCapabilityRouter(params: {
  runtime: IAgentRuntime;
  dir: string;
  ignore: string[];
}): Promise<
  | { ok: true; payload: FileListResult }
  | { ok: false; reason: "unavailable" | "failed"; message: string }
> {
  const router = getCapabilityRouter(params.runtime);
  if (!router) return { ok: false, reason: "unavailable", message: "" };
  try {
    const result = await router.fs.list({
      path: params.dir,
      limit: ENTRY_LIMIT,
      includeHidden: true,
      ignore: params.ignore,
    });
    return { ok: true, payload: result };
  } catch (error) {
    if (
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_UNAVAILABLE"
    ) {
      return { ok: false, reason: "unavailable", message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "failed", message };
  }
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

export async function lsHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
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
  const targetPath =
    requestedPath ?? (await session.getExistingCwd(conversationId)).cwd;

  const validation = await sandbox.validatePath(conversationId, targetPath);
  if (validation.ok === false) {
    const reason =
      validation.reason === "blocked" ? "path_blocked" : "invalid_param";
    return failureToActionResult({ reason, message: validation.message });
  }
  const dir = validation.resolved;

  const ignore = (readArrayParam(options, "ignore") ?? []).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );

  const routed = await listWithCapabilityRouter({ runtime, dir, ignore });
  if (routed.ok) {
    const sorted = sortEntries(routed.payload.entries.map(toLsEntry));
    const text = formatListText({
      dir: routed.payload.path,
      entries: sorted,
      truncated: routed.payload.truncated,
      totalAfterIgnore: routed.payload.totalAfterIgnore,
    });

    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} LS dir=${routed.payload.path} count=${sorted.length} truncated=${routed.payload.truncated}`,
    );

    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, {
      entries: sorted,
      truncated: routed.payload.truncated,
    });
  }
  if (routed.reason === "failed") {
    return failureToActionResult({
      reason: "io_error",
      message: `fs.list failed: ${routed.message}`,
    });
  }

  const ignoreMatchers: RegExp[] = ignore
    .filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    )
    .map((entry) => globToRegExp(entry));

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failureToActionResult({
      reason: "io_error",
      message: `readdir failed: ${msg}`,
    });
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
    }
    enriched.push(size === undefined ? { name, type } : { name, type, size });
  }

  const sorted = sortEntries(enriched);
  const text = formatListText({
    dir,
    entries: sorted,
    truncated,
    totalAfterIgnore,
  });

  coreLogger.debug(
    `${CODING_TOOLS_LOG_PREFIX} LS dir=${dir} count=${sorted.length} truncated=${truncated}`,
  );

  if (callback) await callback({ text, source: "coding-tools" });

  return successActionResult(text, {
    entries: sorted,
    truncated,
  });
}
