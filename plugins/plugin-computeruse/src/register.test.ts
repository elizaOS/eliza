/** Verifies the signed app-shell fallback for the Computer Sessions monitor. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const registerAppShellPage = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/app-shell-registry", () => ({ registerAppShellPage }));

describe("Computer Sessions app registration", () => {
  beforeEach(() => {
    registerAppShellPage.mockClear();
    vi.resetModules();
  });

  it("registers a packaged page with a local component loader", async () => {
    await import("./register.js");

    expect(registerAppShellPage).toHaveBeenCalledOnce();
    expect(registerAppShellPage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "computer-use-sessions",
        pluginId: "@elizaos/plugin-computeruse",
        label: "Computer Sessions",
        path: "/computer-use-sessions",
        viewKind: "release",
        surface: { capabilities: ["agent-surface"] },
        loader: expect.any(Function),
      }),
    );
  });
});
