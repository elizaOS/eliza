/** Exercises the real MCP constants against canonical and malformed env values. */
import { afterEach, describe, expect, it } from "vitest";

const originalMcpTimeout = process.env.MCP_TIMEOUT;
const freshMcpImports = [
  () => import("./mcp.ts?env-test=1"),
  () => import("./mcp.ts?env-test=2"),
  () => import("./mcp.ts?env-test=3"),
  () => import("./mcp.ts?env-test=4"),
  () => import("./mcp.ts?env-test=5"),
  () => import("./mcp.ts?env-test=6"),
  () => import("./mcp.ts?env-test=7"),
];
let importSequence = 0;

async function readRequestTimeout(raw: string | undefined): Promise<number> {
  if (raw === undefined) delete process.env.MCP_TIMEOUT;
  else process.env.MCP_TIMEOUT = raw;
  const loadMcp = freshMcpImports[importSequence];
  importSequence += 1;
  if (!loadMcp) throw new Error("MCP test import sequence exhausted");
  return (await loadMcp()).MCP_REQUEST_TIMEOUT;
}

describe("MCP integer environment settings", () => {
  afterEach(() => {
    if (originalMcpTimeout === undefined) delete process.env.MCP_TIMEOUT;
    else process.env.MCP_TIMEOUT = originalMcpTimeout;
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
