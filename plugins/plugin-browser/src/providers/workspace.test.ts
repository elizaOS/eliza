import { describe, expect, it, vi } from "vitest";
import { browserWorkspaceProvider } from "./workspace.js";

vi.mock("../workspace/browser-workspace.js", () => ({
  getBrowserWorkspaceMode: () => "web",
  listBrowserWorkspaceTabs: async () => [
    {
      id: "tab-1",
      visible: true,
      url: "https://example.com/",
      title: "Example Domain",
    },
  ],
}));

describe("browser workspace context", () => {
  it("identifies the workspace tabs and exposes only resolved available targets", async () => {
    const resolveTargets = vi.fn(async () => [
      { id: "workspace", description: "Built-in browser" },
      { id: "custom-browser", description: "Connected custom browser" },
    ]);
    const result = await browserWorkspaceProvider.get(
      { getService: () => ({ resolveTargets }) } as never,
      {} as never,
    );
    expect(resolveTargets).toHaveBeenCalledWith();
    expect(JSON.parse(result.text ?? "").browser_workspace).toMatchObject({
      target: "workspace",
      availableTargets: [{ id: "workspace" }, { id: "custom-browser" }],
      tabs: [{ id: "tab-1" }],
    });
    expect(result.data?.availableTargetIds).toEqual([
      "workspace",
      "custom-browser",
    ]);
  });
});
