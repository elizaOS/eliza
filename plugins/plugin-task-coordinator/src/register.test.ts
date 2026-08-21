/** Verifies only signed native clients receive the bundled Orchestrator route. */

import { describe, expect, it, vi } from "vitest";

vi.mock("./register-slots.js", () => ({}));
vi.mock("@elizaos/ui/app-shell-registry", () => ({
  registerAppShellPage: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

import { registerNativeTaskCoordinatorPages } from "./register.ts";

describe("Task coordinator app registration", () => {
  it("does not register bundled pages for web or desktop", () => {
    const register = vi.fn();
    registerNativeTaskCoordinatorPages(false, register);
    expect(register).not.toHaveBeenCalled();
  });

  it("matches manifests for the signed native surface", () => {
    const register = vi.fn();
    registerNativeTaskCoordinatorPages(true, register);
    const pages = register.mock.calls.map(([page]) => page);

    expect(
      pages.map(({ id, label, path, viewKind }) => ({
        id,
        label,
        path,
        viewKind,
      })),
    ).toEqual([
      {
        id: "orchestrator",
        label: "Orchestrator",
        path: "/orchestrator",
        viewKind: "developer",
      },
    ]);
    for (const page of pages) {
      expect(page.loader).toBeTypeOf("function");
      expect(page.surface).toEqual({
        header: "fullscreen",
        capabilities: ["agent-surface"],
      });
    }
  });
});
