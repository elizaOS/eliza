import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type ActionResult,
  CapabilityError,
  type FileStat as CapabilityFileStat,
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

type ListPayload = {
  entries: LsEntry[];
  truncated: boolean;
  totalAfterIgnore: number;
};

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

function toLsEntry(stat: CapabilityFileStat): LsEntry {
  const type: EntryType =
    stat.kind === "directory"
      ? "dir"
      : stat.kind === "symlink"
        ? "symlink"
        : "file";
  return type === "file" && stat.size !== undefined
    ? { name: stat.name, type, size: stat.size }
    : { name: stat.name, type };
}

function sortLsEntries(entries: LsEntry[]): LsEntry[] {
  const dirEntries = entries
    .filter((entry) => entry.type === "dir")
    .sort((left, right) => left.name.localeCompare(right.name));
  const fileEntries = entries
    .filter((entry) => entry.type !== "dir")
    .sort((left, right) => left.name.localeCompare(right.name));
  return [...dirEntries, ...fileEntries];
}

function formatLsText(params: {
  dir: string;
  sorted: LsEntry[];
  truncated: boolean;
  totalAfterIgnore: number;
}): string {
  const lines = [
    `Directory: ${params.dir}`,
    ...params.sorted.map((entry) =>
      entry.type === "dir" ? `${entry.name}/` : entry.name,
    ),
  ];
  if (params.truncated) {
    lines.push(
      `…[truncated, listed ${params.sorted.length} of ${params.totalAfterIgnore} entries]`,
    );
  }
  return lines.join("\n");
}

async function listWithCapabilityRouter(params: {
  runtime: IAgentRuntime;
  dir: string;
  ignore: string[];
}): Promise<
  | { ok: true; payload: ListPayload }
  | { ok: false; reason: "unavailable" | "failed"; message: string }
> {
  const router = getCapabilityRouter(params.runtime);
  if (!router) return { ok: false, reason: "unavailable", message: "" };
  try {
    const result = await router.fs.list({
      path: params.dir,
      limit: ENTRY_LIMIT,
      includeHidden: true,
      ...(params.ignore.length === 0 ? {} : { ignore: params.ignore }),
    });
    return {
      ok: true,
      payload: {
        entries: result.entries.map(toLsEntry),
        truncated: result.truncated,
        totalAfterIgnore: result.totalAfterIgnore,
      },
    };
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
  const targetPath = requestedPath ?? session.getCwd(conversationId);

  const validation = await sandbox.validatePath(conversationId, targetPath);
  if (validation.ok === false) {
    const reason =
      validation.reason === "blocked" ? "path_blocked" : "invalid_param";
    return failureToActionResult({ reason, message: validation.message });
  }
  const dir = validation.resolved;

  const ignoreRaw = readArrayParam(options, "ignore");
  const ignoreMatchers: RegExp[] = (ignoreRaw ?? [])
    .filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    )
    .map((entry) => globToRegExp(entry));
  const ignore = ignoreRaw?.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  ) ?? [];

  const routed = await listWithCapabilityRouter({
    runtime,
    dir,
    ignore,
  });
  if (routed.ok) {
    const sorted = sortLsEntries(routed.payload.entries);
    const text = formatLsText({
      dir,
      sorted,
      truncated: routed.payload.truncated,
      totalAfterIgnore: routed.payload.totalAfterIgnore,
    });
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} LS dir=${dir} count=${sorted.length} truncated=${routed.payload.truncated}`,
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
      message: `readdir failed: ${routed.message}`,
    });
  }

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
      // unreadable entry — fall through with default type
    }
    enriched.push(size === undefined ? { name, type } : { name, type, size });
  }

  const sorted = sortLsEntries(enriched);
  const text = formatLsText({ dir, sorted, truncated, totalAfterIgnore });

  coreLogger.debug(
    `${CODING_TOOLS_LOG_PREFIX} LS dir=${dir} count=${sorted.length} truncated=${truncated}`,
  );

  if (callback) await callback({ text, source: "coding-tools" });

  return successActionResult(text, {
    entries: sorted,
    truncated,
  });
}
