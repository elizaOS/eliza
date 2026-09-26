/**
 * Parsing for persisted MCP server configs.
 *
 * `connection.server.config` is stored JSON that other code paths already treat
 * as untrusted (see `restartConnection`, which records a typed connection error
 * for a malformed value). The parse itself has to be total: a hand-edited row or
 * a bad marketplace write must not surface as a raw `SyntaxError` from every
 * transport handler, ping monitor, and `callTool`. Callers get `null` and decide
 * what a missing config means for them; nothing is guessed here.
 */
import type { McpServerConfig } from "../types.ts";

/**
 * Transport derivation shared by handler wiring and the ping monitor. It mirrors
 * the transport `initializeConnection` actually builds
 * (`config.type === "stdio" ? stdio : http`): only an explicit `stdio` type is
 * stdio. A type-less row, a non-object row, or a row that does not parse stays
 * on the HTTP branch exactly as it did before this change.
 */
export function isHttpTransportServerConfig(raw: string | null | undefined): boolean {
  return parseServerConfig(raw)?.type !== "stdio";
}

/**
 * Timeout derivation for `callTool`. An unparseable or non-stdio config keeps
 * the caller's default instead of aborting the call.
 */
export function serverConfigTimeoutMillis(
  raw: string | null | undefined,
  fallback: number
): number {
  const config = parseServerConfig(raw);
  return config?.type === "stdio" && config.timeoutInMillis ? config.timeoutInMillis : fallback;
}

export function parseServerConfig(raw: string | null | undefined): McpServerConfig | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as McpServerConfig;
  } catch {
    return null;
  }
}
