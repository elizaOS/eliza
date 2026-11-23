import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../workspace/browser-workspace.js", () => ({
  getBrowserWorkspaceMode: () => "web",
  listBrowserWorkspaceTabs: async () => [
    {
      id: "btab_1",
      visible: true,
      url: "https://www.google.com/webhp?igu=1",
      title: "google.com",
    },
  ],
}));

const { browserWorkspaceProvider } = await import("./workspace.ts");
const runtime = { getService: () => null } as unknown as IAgentRuntime;
const message = (metadata: Record<string, unknown> = {}) =>
  ({ content: { text: "Summarize this page.", metadata } }) as Memory;
const read = async (metadata?: Record<string, unknown>) =>
  JSON.parse(
    String(
      (
        await browserWorkspaceProvider.get(runtime, message(metadata), {
          values: {},
          data: {},
          text: "",
        })
      )?.text,
    ),
  ).browser_workspace;

describe("browser workspace provider", () => {
  it("says a client device's turn is not about the workspace tabs", async () => {
    const workspace = await read({
      clientDevice: {
        context: {
          view: "browser",
          revision: 1,
          sensitive: false,
          selectedObject: { kind: "browser-tab", id: "s:t", revision: "1" },
        },
      },
    });
    expect(workspace.target).toBe("workspace");
    expect(workspace.note).toMatch(/not the Browser on the device/);
    expect(workspace.note).toContain("clientDevice.browserPage");
    expect(workspace.tabs).toHaveLength(1);
  });

  it("adds nothing for a turn from the host's own app", async () => {
    const workspace = await read();
    expect(workspace.note).toBeUndefined();
    expect(workspace.tabs[0].url).toBe("https://www.google.com/webhp?igu=1");
  });
});
