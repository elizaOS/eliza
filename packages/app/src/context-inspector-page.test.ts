/** Verifies the app registers the context inspector as a developer-only page. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock("@elizaos/ui/app-shell-registry", () => ({
  registerAppShellPage: mocks.register,
}));

describe("context inspector app page", () => {
  beforeEach(() => {
    mocks.register.mockReset();
    vi.resetModules();
  });

  it("registers a developer-only route with a lazy UI loader", async () => {
    await import("./context-inspector-page");
    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "context-inspector",
        path: "/apps/context-inspector",
        viewKind: "developer",
        pluginId: "@elizaos/app",
        loader: expect.any(Function),
      }),
    );
  });
});
