import { describe, expect, it, vi } from "vitest";
import { BashTool } from "../tools/bash";
import { toolSetToBatchTools } from "./tool-schemas";
import { createTools } from "./tools";

const queryLspMock = vi.fn<(cwd: string, input: unknown) => Promise<{ success: boolean; output: string }>>(
  async () => ({
    success: true,
    output: "[]",
  }),
);

vi.mock("../lsp/runtime", () => ({
  isLspToolEnabled: vi.fn(() => true),
  queryLsp: (cwd: string, input: unknown) => queryLspMock(cwd, input),
}));

describe("lsp tool", () => {
  it("registers and routes the first-party lsp tool", async () => {
    const tools = createTools(new BashTool("/tmp"), {} as never, "ask") as Record<
      string,
      { execute: (input: unknown, context?: unknown) => Promise<unknown>; description?: string }
    >;

    expect(tools).toHaveProperty("lsp");
    expect(tools.lsp.description).toContain("Language Server Protocol");

    const result = await tools.lsp.execute(
      {
        operation: "hover",
        filePath: "src/index.ts",
        line: 3,
        character: 7,
      },
      { abortSignal: undefined },
    );

    expect(queryLspMock).toHaveBeenCalledWith("/tmp", {
      operation: "hover",
      filePath: "src/index.ts",
      line: 3,
      character: 7,
      query: undefined,
    });
    expect(result).toEqual({ success: true, output: "[]" });
  });

  it("is compatible with batch tool schema conversion", async () => {
    const tools = createTools(new BashTool("/tmp"), {} as never, "agent");
    const batchTools = await toolSetToBatchTools(tools);
    const lspTool = batchTools.find((entry) => entry.function.name === "lsp");

    expect(lspTool).toBeDefined();
    expect(lspTool?.function.parameters).toMatchObject({
      properties: {
        operation: {
          type: "string",
        },
        filePath: {
          type: "string",
        },
      },
    });
  });
});
