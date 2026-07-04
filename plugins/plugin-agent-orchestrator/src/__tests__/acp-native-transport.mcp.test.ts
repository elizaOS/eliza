/**
 * Verifies parseAcpMcpServersEnv — opt-in sub-agent MCP forwarding.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  type AcpMcpServerConfig,
  parseAcpMcpServersEnv,
} from "../services/acp-native-transport";

describe("parseAcpMcpServersEnv — opt-in sub-agent MCP forwarding", () => {
  it("defaults to [] when unset/empty (prior behavior, no regression)", () => {
    expect(parseAcpMcpServersEnv(undefined)).toEqual([]);
    expect(parseAcpMcpServersEnv("")).toEqual([]);
    expect(parseAcpMcpServersEnv("   ")).toEqual([]);
  });

  it("returns [] for malformed input so spawning can never break", () => {
    expect(parseAcpMcpServersEnv("not json")).toEqual([]);
    expect(parseAcpMcpServersEnv('{"name":"x"}')).toEqual([]); // not an array
    expect(parseAcpMcpServersEnv("[1, 2, 3]")).toEqual([]);
  });

  it("keeps well-formed stdio and http servers", () => {
    const raw = JSON.stringify([
      { name: "fs", command: "mcp-fs", args: ["--root", "/tmp"] },
      { name: "search", type: "http", url: "https://mcp.example/search" },
    ]);
    const out = parseAcpMcpServersEnv(raw);
    expect(out).toHaveLength(2);
    expect((out[0] as { command: string }).command).toBe("mcp-fs");
    expect((out[1] as { url: string }).url).toBe("https://mcp.example/search");
  });

  it("drops entries missing required fields", () => {
    const raw = JSON.stringify([
      { name: "ok", command: "x" },
      { command: "no-name" }, // missing name
      { name: "no-command" }, // missing command and not http
      { name: "http-no-url", type: "http" }, // http missing url
      null,
      "string",
    ]);
    const out: AcpMcpServerConfig[] = parseAcpMcpServersEnv(raw);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("ok");
  });
});
