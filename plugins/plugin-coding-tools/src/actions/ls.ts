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

function conversationIdFromMessage(message: Memory): string | undefined {
  return message.roomId !== undefined && message.roomId !== null
    ? String(message.roomId)
    : undefined;
}

function codingServices(runtime: IAgentRuntime): {
  sandbox: InstanceType<typeof SandboxService>;
  session: InstanceType<typeof SessionCwdService>;
} | null {
  const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
    typeof SandboxService
  > | null;
  const session = runtime.getService(SESSION_CWD_SERVICE) as InstanceType<
    typeof SessionCwdService
  > | null;
  return sandbox && session ? { sandbox, session } : null;
}

function ignoreParams(options: unknown): {
  ignore: string[];
  matchers: RegExp[];
} {
  const ignoreRaw = readArrayParam(options, "ignore");
  const ignore =
    ignoreRaw?.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    ) ?? [];
  return {
    ignore,
    matchers: ignore.map((entry) => globToRegExp(entry)),
  };
}

async function listWithNodeFs(params: {
  dir: string;
  ignoreMatchers: RegExp[];
}): Promise<
  | {
      ok: true;
      entries: LsEntry[];
      truncated: boolean;
      totalAfterIgnore: number;
    }
  | { ok: false; message: string }
> {
  let names: string[];
  try {
    names = await fs.readdir(params.dir);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const filteredNames = names.filter(
    (name) => !params.ignoreMatchers.some((re) => re.test(name)),
  );
  const totalAfterIgnore = filteredNames.length;
  const truncated = totalAfterIgnore > ENTRY_LIMIT;
  const entries = await enrichEntries({
    dir: params.dir,
    names: filteredNames.slice(0, ENTRY_LIMIT),
  });
  return { ok: true, entries, truncated, totalAfterIgnore };
}

async function enrichEntries(params: {
  dir: string;
  names: string[];
}): Promise<LsEntry[]> {
  const enriched: LsEntry[] = [];
  for (const name of params.names) {
    const joined = path.join(params.dir, name);
    let type: EntryType = "file";
    let size: number | undefined;
    try {
      const st = await fs.lstat(joined);
      if (st.isDirectory()) type = "dir";
      if (st.isSymbolicLink()) type = "symlink";
      if (st.isFile()) size = st.size;
    } catch {
      type = "file";
    }
    enriched.push(size === undefined ? { name, type } : { name, type, size });
  }
  return enriched;
}

async function returnLsResult(params: {
  dir: string;
  entries: LsEntry[];
  truncated: boolean;
  totalAfterIgnore: number;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const sorted = sortLsEntries(params.entries);
  const text = formatLsText({
    dir: params.dir,
    sorted,
    truncated: params.truncated,
    totalAfterIgnore: params.totalAfterIgnore,
  });
  coreLogger.debug(
    `${CODING_TOOLS_LOG_PREFIX} LS dir=${params.dir} count=${sorted.length} truncated=${params.truncated}`,
  );
  if (params.callback) await params.callback({ text, source: "coding-tools" });
  return successActionResult(text, {
    entries: sorted,
    truncated: params.truncated,
  });
}

export async function lsHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const conversationId = conversationIdFromMessage(message);
  if (!conversationId) {
    return failureToActionResult({
      reason: "missing_param",
      message: "no roomId",
    });
  }

  const services = codingServices(runtime);
  if (!services) {
    return failureToActionResult({
      reason: "internal",
      message: "coding-tools services unavailable",
    });
  }

  const requestedPath = readStringParam(options, "path");
  const targetPath =
    requestedPath ?? (await services.session.getExistingCwd(conversationId)).cwd;

  const validation = await services.sandbox.validatePath(
    conversationId,
    targetPath,
  );
  if (validation.ok === false) {
    const reason =
      validation.reason === "blocked" ? "path_blocked" : "invalid_param";
    return failureToActionResult({ reason, message: validation.message });
  }
  const dir = validation.resolved;

  const { ignore, matchers } = ignoreParams(options);
  const routed = await listWithCapabilityRouter({
    runtime,
    dir,
    ignore,
  });
  if (routed.ok) {
    return returnLsResult({
      dir,
      entries: routed.payload.entries,
      truncated: routed.payload.truncated,
      totalAfterIgnore: routed.payload.totalAfterIgnore,
      callback,
    });
  }
  if (routed.reason === "failed") {
    return failureToActionResult({
      reason: "io_error",
      message: `readdir failed: ${routed.message}`,
    });
  }

  const local = await listWithNodeFs({ dir, ignoreMatchers: matchers });
  if (!local.ok) {
    return failureToActionResult({
      reason: "io_error",
      message: `readdir failed: ${local.message}`,
    });
  }
  return returnLsResult({
    dir,
    entries: local.entries,
    truncated: local.truncated,
    totalAfterIgnore: local.totalAfterIgnore,
    callback,
  });
}
