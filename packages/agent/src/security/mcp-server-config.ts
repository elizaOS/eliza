/**
 * MCP stdio / remote server config validation (GHSA-54rx-pcr9-hg9x).
 * Shared by the agent API and @elizaos/plugin-mcp spawn path.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import {
  isBlockedPrivateOrLinkLocalIp,
  normalizeHostLike,
} from "./network-policy.ts";

function isBlockedObjectKey(key: string): boolean {
  return (
    key === "__proto__" ||
    key === "constructor" ||
    key === "prototype" ||
    key === "$include"
  );
}

const ALLOWED_MCP_CONFIG_TYPES = new Set([
  "stdio",
  "http",
  "streamable-http",
  "sse",
]);

const ALLOWED_MCP_COMMANDS = new Set([
  "npx",
  "node",
  "bun",
  "bunx",
  "deno",
  "python",
  "python3",
  "uvx",
  "uv",
  "docker",
  "podman",
]);

const BLOCKED_MCP_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "PATH",
  "HOME",
  "SHELL",
]);

const BLOCKED_MCP_ENV_PREFIXES = [
  "NPM_CONFIG_",
  "PNPM_",
  "YARN_",
  "BUN_CONFIG_",
  "UV_",
  "PIP_",
  "PIPX_",
  "PYX_",
  "DENO_",
  "DOCKER_",
  "PODMAN_",
  "BASH_FUNC_",
] as const;

const INTERPRETER_MCP_COMMANDS = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "uv",
]);

const PACKAGE_RUNNER_MCP_COMMANDS = new Set(["npx", "bunx", "uvx"]);
const CONTAINER_MCP_COMMANDS = new Set(["docker", "podman"]);

const BLOCKED_INTERPRETER_FLAGS = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--preload",
  "-c",
  "-m",
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--inspect-port",
  "--inspect-publish-uid",
  "--experimental-policy",
  "--diagnostic-dir",
]);

const BLOCKED_PACKAGE_RUNNER_FLAGS = new Set(["-c", "--call", "-e", "--eval"]);
const BLOCKED_CONTAINER_FLAGS = new Set([
  "--privileged",
  "-v",
  "--volume",
  "--mount",
  "--cap-add",
  "--security-opt",
  "--pid",
  "--network",
  "--device",
  "--ipc",
  "--uts",
  "--userns",
  "--cgroupns",
]);
const BLOCKED_DENO_SUBCOMMANDS = new Set(["eval"]);
const BLOCKED_MCP_REMOTE_HOST_LITERALS = new Set([
  "localhost",
  "metadata.google.internal",
]);

function blockedMcpEnvPrefix(upperKey: string): string | null {
  for (const prefix of BLOCKED_MCP_ENV_PREFIXES) {
    if (upperKey.startsWith(prefix)) {
      return prefix;
    }
  }
  return null;
}

function rejectMcpEnvEntry(key: string, value: string): string | null {
  if (isBlockedObjectKey(key)) {
    return `env key "${key}" is blocked for security reasons`;
  }
  const upper = key.toUpperCase();
  if (BLOCKED_MCP_ENV_KEYS.has(upper)) {
    return `env variable "${key}" is not allowed for security reasons`;
  }
  const prefix = blockedMcpEnvPrefix(upper);
  if (prefix) {
    return `env variable "${key}" matches blocked prefix ${prefix} and is not allowed`;
  }
  if (value.includes("\0")) {
    return `env variable "${key}" contains a null byte and is not allowed`;
  }
  return null;
}

function normalizeMcpCommand(command: string): string {
  const baseName = command.replace(/\\/g, "/").split("/").pop() ?? "";
  return baseName.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

function hasBlockedFlag(
  args: string[],
  blockedFlags: ReadonlySet<string>,
): string | null {
  for (const arg of args) {
    const trimmed = arg.trim();
    for (const flag of blockedFlags) {
      if (trimmed === flag || trimmed.startsWith(`${flag}=`)) {
        return flag;
      }
      if (
        /^-[A-Za-z]$/.test(flag) &&
        trimmed.startsWith(flag) &&
        trimmed.length > flag.length
      ) {
        return flag;
      }
    }
  }
  return null;
}

function firstPositionalArg(args: string[]): string | null {
  for (const arg of args) {
    const trimmed = arg.trim();
    if (!trimmed || trimmed === "--" || trimmed.startsWith("-")) continue;
    return trimmed.toLowerCase();
  }
  return null;
}

async function resolveMcpRemoteUrlRejection(
  rawUrl: string,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "URL must be a valid absolute URL";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must use http:// or https://";
  }

  const hostname = normalizeHostLike(parsed.hostname);
  if (!hostname) return "URL hostname is required";

  if (
    BLOCKED_MCP_REMOTE_HOST_LITERALS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return `URL host "${hostname}" is blocked for security reasons`;
  }

  if (net.isIP(hostname)) {
    if (isBlockedPrivateOrLinkLocalIp(hostname)) {
      return `URL host "${hostname}" is blocked for security reasons`;
    }
    return null;
  }

  let addresses: Array<{ address: string }>;
  try {
    const resolved = await dnsLookup(hostname, { all: true });
    addresses = Array.isArray(resolved) ? resolved : [resolved];
  } catch {
    return `Could not resolve URL host "${hostname}"`;
  }

  if (addresses.length === 0) {
    return `Could not resolve URL host "${hostname}"`;
  }

  for (const entry of addresses) {
    if (isBlockedPrivateOrLinkLocalIp(entry.address)) {
      return `URL host "${hostname}" resolves to blocked address ${entry.address}`;
    }
  }

  return null;
}

export async function validateMcpServerConfig(
  config: Record<string, unknown>,
): Promise<string | null> {
  const configType = config.type;
  if (
    typeof configType !== "string" ||
    !ALLOWED_MCP_CONFIG_TYPES.has(configType)
  ) {
    return `Invalid config type. Must be one of: ${[...ALLOWED_MCP_CONFIG_TYPES].join(", ")}`;
  }

  if (configType === "stdio") {
    const command =
      typeof config.command === "string" ? config.command.trim() : "";
    if (!command) {
      return "Command is required for stdio servers";
    }
    if (!/^[A-Za-z0-9._-]+$/.test(command)) {
      return "Command must be a bare executable name without path separators";
    }

    const normalizedCommand = normalizeMcpCommand(command);
    if (!ALLOWED_MCP_COMMANDS.has(normalizedCommand)) {
      return (
        `Command "${command}" is not allowed. ` +
        `Allowed commands: ${[...ALLOWED_MCP_COMMANDS].join(", ")}`
      );
    }

    if (config.args !== undefined) {
      if (!Array.isArray(config.args)) {
        return "args must be an array of strings";
      }
      for (const arg of config.args) {
        if (typeof arg !== "string") {
          return "Each arg must be a string";
        }
      }
      const args = config.args as string[];
      if (INTERPRETER_MCP_COMMANDS.has(normalizedCommand)) {
        const blocked = hasBlockedFlag(args, BLOCKED_INTERPRETER_FLAGS);
        if (blocked) {
          return `Flag "${blocked}" is not allowed for ${normalizedCommand} MCP servers`;
        }
      }
      if (PACKAGE_RUNNER_MCP_COMMANDS.has(normalizedCommand)) {
        const blocked = hasBlockedFlag(args, BLOCKED_PACKAGE_RUNNER_FLAGS);
        if (blocked) {
          return `Flag "${blocked}" is not allowed for ${normalizedCommand} MCP servers`;
        }
      }
      if (CONTAINER_MCP_COMMANDS.has(normalizedCommand)) {
        const blocked = hasBlockedFlag(args, BLOCKED_CONTAINER_FLAGS);
        if (blocked) {
          return `Flag "${blocked}" is not allowed for ${normalizedCommand} MCP servers`;
        }
      }
      if (normalizedCommand === "deno") {
        const subcommand = firstPositionalArg(args);
        if (subcommand && BLOCKED_DENO_SUBCOMMANDS.has(subcommand)) {
          return `Subcommand "${subcommand}" is not allowed for deno MCP servers`;
        }
      }
    }
  } else {
    const url = typeof config.url === "string" ? config.url.trim() : "";
    if (!url) {
      return "URL is required for remote servers";
    }
    const urlRejection = await resolveMcpRemoteUrlRejection(url);
    if (urlRejection) return urlRejection;
  }

  if (config.env !== undefined) {
    if (
      typeof config.env !== "object" ||
      config.env === null ||
      Array.isArray(config.env)
    ) {
      return "env must be a plain object of string key-value pairs";
    }

    for (const [key, value] of Object.entries(config.env)) {
      if (typeof value !== "string") {
        return `env.${key} must be a string`;
      }
      const rejection = rejectMcpEnvEntry(key, value);
      if (rejection) return rejection;
    }
  }

  if (config.cwd !== undefined && typeof config.cwd !== "string") {
    return "cwd must be a string";
  }

  if (config.timeoutInMillis !== undefined) {
    if (
      typeof config.timeoutInMillis !== "number" ||
      !Number.isFinite(config.timeoutInMillis) ||
      config.timeoutInMillis < 0
    ) {
      return "timeoutInMillis must be a non-negative number";
    }
  }

  return null;
}
