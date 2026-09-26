/**
 * A malformed persisted server config must not reach callers as a raw
 * `SyntaxError`: `setupTransportHandlers`, `startPingMonitoring`, and
 * `callTool` all parse the same stored JSON, and only `restartConnection`
 * recorded a typed failure. `parseServerConfig` is total, so the call sites can
 * fall back to the stdio default (transport) and the default timeout instead of
 * crashing the connection.
 */
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../types.ts";
import {
  isHttpTransportServerConfig,
  parseServerConfig,
  serverConfigTimeoutMillis,
} from "../server-config.ts";

describe("parseServerConfig", () => {
  it("returns the parsed object for a valid stored config", () => {
    const parsed = parseServerConfig(
      JSON.stringify({ type: "stdio", command: "node", timeoutInMillis: 5000 })
    );
    expect(parsed).toEqual({
      type: "stdio",
      command: "node",
      timeoutInMillis: 5000,
    });
    expect((parsed as McpServerConfig).type).toBe("stdio");
  });

  it("returns null instead of throwing for malformed JSON", () => {
    expect(parseServerConfig('{"type": "stdio"')).toBeNull();
    expect(parseServerConfig("not json at all")).toBeNull();
    expect(parseServerConfig("")).toBeNull();
  });

  it("returns null for JSON that is not a config object", () => {
    expect(parseServerConfig("42")).toBeNull();
    expect(parseServerConfig("null")).toBeNull();
    expect(parseServerConfig("[1,2,3]")).toBeNull();
    expect(parseServerConfig('"stdio"')).toBeNull();
  });

  it("returns null for a missing or non-string column value", () => {
    expect(parseServerConfig(null)).toBeNull();
    expect(parseServerConfig(undefined)).toBeNull();
  });

  it("derives the transport the production call sites use, mirroring initializeConnection", () => {
    // Only an explicit "stdio" type is stdio; every other row — including the
    // type-less, non-object, and malformed rows that bypass isMcpSettings — stays
    // on the HTTP branch, exactly as
    // `connection.server.config.type === "stdio" ? stdio : http` behaves when the
    // live transport is built.
    expect(isHttpTransportServerConfig('{"type":"stdio","command":"node"}')).toBe(false);
    expect(isHttpTransportServerConfig('{"type":"sse"}')).toBe(true);
    expect(isHttpTransportServerConfig('{"type":"streamable-http"}')).toBe(true);
    expect(isHttpTransportServerConfig('{"url":"https://example.test/mcp"}')).toBe(true);
    expect(isHttpTransportServerConfig("{}")).toBe(true);
    // Malformed and non-object rows no longer throw inside handler wiring.
    expect(isHttpTransportServerConfig("{oops")).toBe(true);
    expect(isHttpTransportServerConfig("[1,2,3]")).toBe(true);
    expect(isHttpTransportServerConfig(null)).toBe(true);
  });

  it("derives the callTool timeout the production call site uses", () => {
    const FALLBACK = 60;
    expect(serverConfigTimeoutMillis('{"type":"stdio","timeoutInMillis":5000}', FALLBACK)).toBe(
      5000
    );
    expect(serverConfigTimeoutMillis('{"type":"sse"}', FALLBACK)).toBe(FALLBACK);
    expect(serverConfigTimeoutMillis("{oops", FALLBACK)).toBe(FALLBACK);
    expect(serverConfigTimeoutMillis("", FALLBACK)).toBe(FALLBACK);
  });
});
