/** Verifies the signed app-shell registration for the Relationships view. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const registerAppShellPage = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/app-shell-registry", () => ({
  registerAppShellPage,
}));

describe("Relationships app registration", () => {
  beforeEach(() => registerAppShellPage.mockClear());

  it("registers the plugin-owned route with a local loader", async () => {
    vi.resetModules();
    await import("./register.ts");

    expect(registerAppShellPage).toHaveBeenCalledOnce();
    expect(registerAppShellPage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "relationships",
        pluginId: "@elizaos/plugin-relationships",
        path: "/relationships",
        pathPatterns: ["/apps/relationships", "/character/relationships"],
        loader: expect.any(Function),
        surface: {
          header: "fullscreen",
          capabilities: ["agent-surface"],
        },
      }),
    );
  });
});
