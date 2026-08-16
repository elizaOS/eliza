/** Exercises the real MCP constants against canonical and malformed env values. */
import { afterEach, describe, expect, it, vi } from "vitest";

async function readRequestTimeout(raw: string | undefined): Promise<number> {
  vi.resetModules();
  if (raw === undefined) vi.stubEnv("MCP_TIMEOUT", undefined);
  else vi.stubEnv("MCP_TIMEOUT", raw);
  return (await import("./mcp")).MCP_REQUEST_TIMEOUT;
}

describe("MCP integer environment settings", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    [undefined, 60],
    ["0", 0],
    [" 25 ", 25],
    ["5junk", 60],
    ["1e3", 60],
    ["-1", 60],
    ["9007199254740993", 60],
  ])("parses MCP_TIMEOUT %j as %i", async (raw, expected) => {
    expect(await readRequestTimeout(raw)).toBe(expected);
  });
});
