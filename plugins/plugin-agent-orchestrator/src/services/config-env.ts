/**
 * Read settings from the eliza/eliza config file's env section.
 *
 * runtime.getSetting() checks character.settings but NOT the config's env
 * section which is where the UI writes settings. This reads the config
 * file directly so settings take effect without restart.
 *
 * @module services/config-env
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { getElizaNamespace, resolveStateDir } from "@elizaos/core";
import type { AcpMcpServerConfig } from "./acp-native-transport.js";

function readConfig(): Record<string, unknown> | undefined {
  try {
    const explicitPath = process.env.ELIZA_CONFIG_PATH?.trim();
    const configPath = explicitPath
      ? path.resolve(explicitPath)
      : (() => {
          const namespace = getElizaNamespace();
          const filename =
            namespace === "eliza" ? "eliza.json" : `${namespace}.json`;
          return path.join(resolveStateDir(), filename);
        })();
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    // error-policy:J3 optional config file absent (ENOENT) or unparseable → undefined
    // "not configured"; callers fall back to process.env, never a fake-valid default.
    return undefined;
  }
}

export function readConfigEnvKey(key: string): string | undefined {
  // Prefer the config file's env section: the UI writes settings there and
  // changes take effect without a process restart. Fall back to process.env
  // so operators who set values via a systemd EnvironmentFile (service.env)
  // or shell export are honoured — these paths were silently ignored before,
  // causing `ELIZA_OPENCODE_*` overrides to be dropped on the floor.
  const config = readConfig();
  const val = (config?.env as Record<string, unknown> | undefined)?.[key];
  if (typeof val === "string" && val.length > 0) return val;
  const fromProcessEnv = process.env[key];
  return typeof fromProcessEnv === "string" && fromProcessEnv.length > 0
    ? fromProcessEnv
    : undefined;
}

/** Read a key from the cloud section of the config (e.g. "apiKey"). */
export function readConfigCloudKey(key: string): string | undefined {
  const config = readConfig();
  const val = (config?.cloud as Record<string, unknown> | undefined)?.[key];
  return typeof val === "string" ? val : undefined;
}

/** Convert an MCP `{ KEY: "value" }` record (env / headers) to the ACP
 * `[{ name, value }]` shape, dropping non-string values. */
function recordToNameValue(
  obj: unknown,
): Array<{ name: string; value: string }> | undefined {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(obj as Record<string, unknown>)) {
    if (name && typeof value === "string") out.push({ name, value });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Read the runtime's configured MCP servers from the config's `mcp.servers`
 * object — the same map the dashboard `/api/config` route validates and
 * persists — and convert it to the ACP `session/new.mcpServers` array shape, so
 * spawned sub-agents automatically inherit the parent's MCP tools (Codex /
 * Claude-Code parity) without the operator duplicating them in
 * `ELIZA_ACP_MCP_SERVERS`.
 *
 * Returns undefined when nothing is configured (so the env-var fallback in the
 * transport still applies) and silently drops malformed entries — it must never
 * throw, since it runs on the sub-agent spawn path.
 */
export function readConfigMcpServers(): AcpMcpServerConfig[] | undefined {
  const config = readConfig();
  const servers = (config?.mcp as { servers?: unknown } | undefined)?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return undefined;
  }
  const out: AcpMcpServerConfig[] = [];
  for (const [name, raw] of Object.entries(
    servers as Record<string, unknown>,
  )) {
    if (!name || !raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : undefined;
    const url = typeof entry.url === "string" ? entry.url : undefined;
    // Remote MCP: an explicit http(-ish) transport type or a URL.
    if (url && (type === undefined || type.includes("http"))) {
      const headers = recordToNameValue(entry.headers);
      out.push({ name, type: "http", url, ...(headers ? { headers } : {}) });
      continue;
    }
    // Local stdio MCP: requires a command.
    const command =
      typeof entry.command === "string" ? entry.command : undefined;
    if (!command) continue;
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const env = recordToNameValue(entry.env);
    out.push({
      name,
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}
