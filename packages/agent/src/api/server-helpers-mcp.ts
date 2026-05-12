/**
 * MCP server configuration validation helpers extracted from server.ts.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type http from "node:http";
import net from "node:net";
import {
  isBlockedPrivateOrLinkLocalIp,
  normalizeHostLike,
} from "../security/network-policy.ts";
import { hasBlockedObjectKeyDeep } from "./server-helpers.ts";
import type { TerminalRunRejection } from "./server-helpers-auth.ts";
import { resolveTerminalRunRejection } from "./server-helpers-auth.ts";

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
  // V8 inspector -- opens an unauthenticated debug port (default 9229) that
  // allows arbitrary code execution via Chrome DevTools Protocol.  If bound
  // to 0.0.0.0, any network peer can connect -> RCE without any token.
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--inspect-port",
  "--inspect-publish-uid",
  // Policy / diagnostics file access
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
      // Block attached short-option forms like -cpayload or -epayload.
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

function isBlockedObjectKey(key: string): boolean {
  return (
    key === "__proto__" ||
    key === "constructor" ||
    key === "prototype" ||
    // Block config include directives -- if an API caller embeds "$include"
    // inside a config patch, the next loadElizaConfig() -> resolveConfigIncludes
    // pass would read arbitrary local files and merge them into the config.
    key === "$include"
  );
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
      if (isBlockedObjectKey(key)) {
        return `env key "${key}" is blocked for security reasons`;
      }
      if (typeof value !== "string") {
        return `env.${key} must be a string`;
      }
      if (BLOCKED_MCP_ENV_KEYS.has(key.toUpperCase())) {
        return `env variable "${key}" is not allowed for security reasons`;
      }
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

export async function resolveMcpServersRejection(
  servers: Record<string, unknown>,
): Promise<string | null> {
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    if (isBlockedObjectKey(serverName)) {
      return `Invalid server name: "${serverName}"`;
    }
    if (
      !serverConfig ||
      typeof serverConfig !== "object" ||
      Array.isArray(serverConfig)
    ) {
      return `Server "${serverName}" config must be a JSON object`;
    }
    if (hasBlockedObjectKeyDeep(serverConfig)) {
      return `Server "${serverName}" contains blocked object keys`;
    }
    const configError = await validateMcpServerConfig(
      serverConfig as Record<string, unknown>,
    );
    if (configError) {
      return `Server "${serverName}": ${configError}`;
    }
  }
  return null;
}

export function mcpServersIncludeStdio(
  servers: Record<string, unknown>,
): boolean {
  return Object.values(servers).some((serverConfig) => {
    if (
      !serverConfig ||
      typeof serverConfig !== "object" ||
      Array.isArray(serverConfig)
    ) {
      return false;
    }
    return (serverConfig as Record<string, unknown>).type === "stdio";
  });
}

export function resolveMcpTerminalAuthorizationRejection(
  req: Pick<http.IncomingMessage, "headers">,
  servers: Record<string, unknown>,
  body: { terminalToken?: string },
): TerminalRunRejection | null {
  if (!mcpServersIncludeStdio(servers)) {
    return null;
  }
  return resolveTerminalRunRejection(req as http.IncomingMessage, body);
}
