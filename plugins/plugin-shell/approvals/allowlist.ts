/**
 * Allowlist Management
 *
 * Functions for managing the exec approval allowlist.
 * Handles loading, saving, and modifying allowlist entries.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import type {
  CommandResolution,
  ExecAllowlistEntry,
  ExecApprovalsAgent,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecApprovalsResolved,
  ExecApprovalsSnapshot,
  ExecAsk,
  ExecSecurity,
} from "./types";
import { EXEC_APPROVAL_DEFAULTS } from "./types";

/** Default socket path for external approval UI */
const DEFAULT_SOCKET_PATH = "~/.eliza/exec-approvals.sock";

/** Default file path for approval configuration */
const DEFAULT_FILE_PATH = "~/.eliza/exec-approvals.json";

/** Default agent ID */
const DEFAULT_AGENT_ID = "default";

/**
 * Expand home directory in path
 */
function expandHome(value: string): string {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Hash raw content for change detection
 */
function hashContent(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

/**
 * Get the default approval file path
 */
export function getApprovalFilePath(): string {
  return expandHome(DEFAULT_FILE_PATH);
}

/**
 * Get the default socket path
 */
export function getApprovalSocketPath(): string {
  return expandHome(DEFAULT_SOCKET_PATH);
}

/**
 * Ensure directory exists for a file path
 */
function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Normalize allowlist pattern for comparison
 */
function normalizePattern(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Ensure all allowlist entries have IDs
 */
function ensureAllowlistIds(
  allowlist: ExecAllowlistEntry[] | undefined
): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return allowlist;
  }

  let changed = false;
  const next = allowlist.map((entry) => {
    if (entry.id) return entry;
    changed = true;
    return { ...entry, id: crypto.randomUUID() };
  });

  return changed ? next : allowlist;
}

/**
 * Merge legacy agent configuration with current
 */
function mergeLegacyAgent(
  current: ExecApprovalsAgent,
  legacy: ExecApprovalsAgent
): ExecApprovalsAgent {
  const allowlist: ExecAllowlistEntry[] = [];
  const seen = new Set<string>();

  const pushEntry = (entry: ExecAllowlistEntry) => {
    const key = normalizePattern(entry.pattern);
    if (!key || seen.has(key)) return;
    seen.add(key);
    allowlist.push(entry);
  };

  for (const entry of current.allowlist ?? []) pushEntry(entry);
  for (const entry of legacy.allowlist ?? []) pushEntry(entry);

  return {
    security: current.security ?? legacy.security,
    ask: current.ask ?? legacy.ask,
    askFallback: current.askFallback ?? legacy.askFallback,
    autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
    allowlist: allowlist.length > 0 ? allowlist : undefined,
  };
}

/**
 * Normalize approval configuration file
 */
export function normalizeApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  const token = file.socket?.token?.trim();
  const agents = { ...file.agents };

  // Handle legacy "default" agent
  const legacyDefault = agents.default;
  if (legacyDefault) {
    const main = agents[DEFAULT_AGENT_ID];
    agents[DEFAULT_AGENT_ID] = main ? mergeLegacyAgent(main, legacyDefault) : legacyDefault;
    delete agents.default;
  }

  // Ensure all allowlist entries have IDs
  for (const [key, agent] of Object.entries(agents)) {
    const allowlist = ensureAllowlistIds(agent.allowlist);
    if (allowlist !== agent.allowlist) {
      agents[key] = { ...agent, allowlist };
    }
  }

  return {
    version: 1,
    socket: {
      path: socketPath && socketPath.length > 0 ? socketPath : undefined,
      token: token && token.length > 0 ? token : undefined,
    },
    defaults: {
      security: file.defaults?.security,
      ask: file.defaults?.ask,
      askFallback: file.defaults?.askFallback,
      autoAllowSkills: file.defaults?.autoAllowSkills,
    },
    agents,
  };
}

/**
 * Generate a secure token
 */
function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Read approval configuration snapshot
 */
export function readApprovalsSnapshot(): ExecApprovalsSnapshot {
  const filePath = getApprovalFilePath();

  if (!fs.existsSync(filePath)) {
    const file = normalizeApprovals({ version: 1, agents: {} });
    return {
      path: filePath,
      exists: false,
      raw: null,
      file,
      hash: hashContent(null),
    };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: ExecApprovalsFile | null = null;

  try {
    parsed = JSON.parse(raw) as ExecApprovalsFile;
  } catch (parseError) {
    logger.warn(
      { src: "exec-approval", parseError, filePath },
      "Failed to parse approval config snapshot - file may be corrupted"
    );
    parsed = null;
  }

  const file =
    parsed?.version === 1
      ? normalizeApprovals(parsed)
      : normalizeApprovals({ version: 1, agents: {} });

  if (parsed && parsed.version !== 1) {
    logger.warn(
      { src: "exec-approval", version: parsed.version, filePath },
      "Approval config snapshot has unexpected version"
    );
  }

  return {
    path: filePath,
    exists: true,
    raw,
    file,
    hash: hashContent(raw),
  };
}

/**
 * Load approval configuration
 */
export function loadApprovals(): ExecApprovalsFile {
  const filePath = getApprovalFilePath();

  try {
    if (!fs.existsSync(filePath)) {
      logger.debug(
        { src: "exec-approval", filePath },
        "Approval config file does not exist, using defaults"
      );
      return normalizeApprovals({ version: 1, agents: {} });
    }

    const raw = fs.readFileSync(filePath, "utf8");
    let parsed: ExecApprovalsFile;

    try {
      parsed = JSON.parse(raw) as ExecApprovalsFile;
    } catch (parseError) {
      logger.error(
        { src: "exec-approval", parseError, filePath },
        "Failed to parse approval config JSON - file may be corrupted. Using defaults."
      );
      return normalizeApprovals({ version: 1, agents: {} });
    }

    if (parsed?.version !== 1) {
      logger.warn(
        { src: "exec-approval", version: parsed?.version, filePath },
        "Approval config has unexpected version, using defaults"
      );
      return normalizeApprovals({ version: 1, agents: {} });
    }

    return normalizeApprovals(parsed);
  } catch (error) {
    logger.error(
      { src: "exec-approval", error, filePath },
      "Failed to load approval config - using defaults. This may indicate a permissions issue."
    );
    return normalizeApprovals({ version: 1, agents: {} });
  }
}

/**
 * Save approval configuration
 * @throws Error if file cannot be written
 */
export function saveApprovals(file: ExecApprovalsFile): void {
  const filePath = getApprovalFilePath();
  try {
    ensureDir(filePath);
    fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
    });

    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort on platforms without chmod (e.g., Windows)
    }
  } catch (error) {
    logger.error(
      { src: "exec-approval", error, filePath },
      "Failed to save approval configuration"
    );
    throw new Error(`Failed to save approval configuration to ${filePath}: ${error}`);
  }
}

/**
 * Ensure approval configuration exists with socket/token
 * @throws Error if configuration cannot be loaded or saved
 */
export function ensureApprovals(): ExecApprovalsFile {
  const loaded = loadApprovals();
  const next = normalizeApprovals(loaded);

  const socketPath = next.socket?.path?.trim();
  const token = next.socket?.token?.trim();

  const updated: ExecApprovalsFile = {
    ...next,
    socket: {
      path: socketPath && socketPath.length > 0 ? socketPath : getApprovalSocketPath(),
      token: token && token.length > 0 ? token : generateToken(),
    },
  };

  // Try to save - if it fails, we can still return the in-memory config
  // but the caller should handle the error appropriately
  try {
    saveApprovals(updated);
  } catch (error) {
    logger.warn(
      { src: "exec-approval", error },
      "Failed to save approval config during ensureApprovals - " +
        "returning in-memory config. Changes will not persist."
    );
    // Re-throw so caller knows something went wrong
    throw error;
  }

  return updated;
}

/**
 * Normalize security value
 */
function normalizeSecurity(value: ExecSecurity | undefined, fallback: ExecSecurity): ExecSecurity {
  if (value === "allowlist" || value === "full" || value === "deny") {
    return value;
  }
  return fallback;
}

/**
 * Normalize ask value
 */
function normalizeAsk(value: ExecAsk | undefined, fallback: ExecAsk): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") {
    return value;
  }
  return fallback;
}

/**
 * Resolve approval configuration for an agent
 * @throws Error if configuration cannot be loaded or saved
 */
export function resolveApprovals(
  agentId?: string,
  overrides?: Partial<ExecApprovalsDefaults>
): ExecApprovalsResolved {
  // Try to ensure approvals exist (may fail if can't write to disk)
  // If it fails, we load what we can and proceed with that
  let file: ExecApprovalsFile;
  try {
    file = ensureApprovals();
  } catch (error) {
    // ensureApprovals failed (likely can't write) - use loadApprovals which is read-only
    logger.warn(
      { src: "exec-approval", error },
      "Could not ensure approval config exists - using read-only config"
    );
    file = loadApprovals();
  }

  return resolveApprovalsFromFile({
    file,
    agentId,
    overrides,
    path: getApprovalFilePath(),
    socketPath: expandHome(file.socket?.path ?? getApprovalSocketPath()),
    token: file.socket?.token ?? "",
  });
}

/**
 * Resolve approval configuration from a loaded file
 */
export function resolveApprovalsFromFile(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: Partial<ExecApprovalsDefaults>;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const file = normalizeApprovals(params.file);
  const defaults = file.defaults ?? {};
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;
  const agent = file.agents?.[agentKey] ?? {};
  const wildcard = file.agents?.["*"] ?? {};

  const fallbackSecurity = params.overrides?.security ?? EXEC_APPROVAL_DEFAULTS.security;
  const fallbackAsk = params.overrides?.ask ?? EXEC_APPROVAL_DEFAULTS.ask;
  const fallbackAskFallback = params.overrides?.askFallback ?? EXEC_APPROVAL_DEFAULTS.askFallback;
  const fallbackAutoAllowSkills =
    params.overrides?.autoAllowSkills ?? EXEC_APPROVAL_DEFAULTS.autoAllowSkills;

  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(defaults.security, fallbackSecurity),
    ask: normalizeAsk(defaults.ask, fallbackAsk),
    askFallback: normalizeSecurity(
      defaults.askFallback ?? fallbackAskFallback,
      fallbackAskFallback
    ),
    autoAllowSkills: Boolean(defaults.autoAllowSkills ?? fallbackAutoAllowSkills),
  };

  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(
      agent.security ?? wildcard.security ?? resolvedDefaults.security,
      resolvedDefaults.security
    ),
    ask: normalizeAsk(agent.ask ?? wildcard.ask ?? resolvedDefaults.ask, resolvedDefaults.ask),
    askFallback: normalizeSecurity(
      agent.askFallback ?? wildcard.askFallback ?? resolvedDefaults.askFallback,
      resolvedDefaults.askFallback
    ),
    autoAllowSkills: Boolean(
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills
    ),
  };

  const allowlist = [
    ...(Array.isArray(wildcard.allowlist) ? wildcard.allowlist : []),
    ...(Array.isArray(agent.allowlist) ? agent.allowlist : []),
  ];

  return {
    path: params.path ?? getApprovalFilePath(),
    socketPath: expandHome(params.socketPath ?? file.socket?.path ?? getApprovalSocketPath()),
    token: params.token ?? file.socket?.token ?? "",
    defaults: resolvedDefaults,
    agent: resolvedAgent,
    allowlist,
    file,
  };
}

/**
 * Match command against allowlist
 */
export function matchAllowlist(
  entries: ExecAllowlistEntry[],
  resolution: CommandResolution | null
): ExecAllowlistEntry | null {
  if (!entries.length || !resolution?.resolvedPath) {
    return null;
  }

  const resolvedPath = resolution.resolvedPath;

  for (const entry of entries) {
    const pattern = entry.pattern?.trim();
    if (!pattern) continue;

    const hasPath = pattern.includes("/") || pattern.includes("\\") || pattern.includes("~");
    if (!hasPath) continue;

    if (matchesPattern(pattern, resolvedPath)) {
      return entry;
    }
  }

  return null;
}

/**
 * Check if pattern matches target
 */
function matchesPattern(pattern: string, target: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;

  const expanded = trimmed.startsWith("~") ? expandHome(trimmed) : trimmed;
  const hasWildcard = /[*?]/.test(expanded);

  let normalizedPattern = expanded;
  let normalizedTarget = target;

  if (process.platform === "win32" && !hasWildcard) {
    normalizedPattern = tryRealpath(expanded) ?? expanded;
    normalizedTarget = tryRealpath(target) ?? target;
  }

  normalizedPattern = normalizeMatchTarget(normalizedPattern);
  normalizedTarget = normalizeMatchTarget(normalizedTarget);

  const regex = globToRegExp(normalizedPattern);
  return regex.test(normalizedTarget);
}

/**
 * Normalize path for matching
 */
function normalizeMatchTarget(value: string): string {
  if (process.platform === "win32") {
    const stripped = value.replace(/^\\\\[?.]\\/, "");
    return stripped.replace(/\\/g, "/").toLowerCase();
  }
  return value.replace(/\\\\/g, "/").toLowerCase();
}

/**
 * Try to get realpath (resolve symlinks)
 */
function tryRealpath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

/**
 * Convert glob pattern to RegExp
 */
function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        regex += ".*";
        i += 2;
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }

    if (ch === "?") {
      regex += ".";
      i += 1;
      continue;
    }

    regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }

  regex += "$";
  return new RegExp(regex, "i");
}

/**
 * Record allowlist usage
 * @returns true if successful, false if save failed
 */
export function recordAllowlistUse(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  entry: ExecAllowlistEntry,
  command: string,
  resolvedPath?: string
): boolean {
  const target = agentId ?? DEFAULT_AGENT_ID;
  const agents = approvals.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];

  const nextAllowlist = allowlist.map((item) =>
    item.pattern === entry.pattern
      ? {
          ...item,
          id: item.id ?? crypto.randomUUID(),
          lastUsedAt: Date.now(),
          lastUsedCommand: command,
          lastResolvedPath: resolvedPath,
        }
      : item
  );

  agents[target] = { ...existing, allowlist: nextAllowlist };
  approvals.agents = agents;

  try {
    saveApprovals(approvals);
    return true;
  } catch (error) {
    logger.warn(
      { src: "exec-approval", error, pattern: entry.pattern },
      "Failed to record allowlist usage - continuing without update"
    );
    return false;
  }
}

/**
 * Add a new allowlist entry
 * @returns true if entry was added, false if already exists or save failed
 */
export function addAllowlistEntry(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  pattern: string
): boolean {
  const target = agentId ?? DEFAULT_AGENT_ID;
  const agents = approvals.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];

  const trimmed = pattern.trim();
  if (!trimmed) {
    logger.warn({ src: "exec-approval" }, "Attempted to add empty pattern to allowlist");
    return false;
  }

  if (allowlist.some((entry) => entry.pattern === trimmed)) {
    logger.debug({ src: "exec-approval", pattern: trimmed }, "Pattern already in allowlist");
    return false;
  }

  allowlist.push({
    id: crypto.randomUUID(),
    pattern: trimmed,
    lastUsedAt: Date.now(),
  });

  agents[target] = { ...existing, allowlist };
  approvals.agents = agents;

  try {
    saveApprovals(approvals);
    logger.info(
      { src: "exec-approval", pattern: trimmed, agentId: target },
      "Added pattern to allowlist"
    );
    return true;
  } catch (error) {
    logger.error(
      { src: "exec-approval", error, pattern: trimmed },
      "Failed to save allowlist after adding entry"
    );
    return false;
  }
}

/**
 * Get minimum security level
 */
export function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity {
  const order: Record<ExecSecurity, number> = {
    deny: 0,
    allowlist: 1,
    full: 2,
  };
  return order[a] <= order[b] ? a : b;
}

/**
 * Get maximum ask level
 */
export function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk {
  const order: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[a] >= order[b] ? a : b;
}
