import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: mocks,
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  readdirSync: mocks.readdirSync,
}));

import { discoverSideEffectAppModules } from "./app-side-effect-modules.ts";

describe("discoverSideEffectAppModules", () => {
  it("discovers register-mode plugins", () => {
    mocks.readdirSync.mockReturnValue([
      { name: "plugin-a", isDirectory: () => true },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        name: "@scope/plugin-a",
        elizaos: { appRegister: "register" },
      }),
    );
    mocks.existsSync.mockImplementation(
      (p: string) =>
        p === "/repo/plugins" ||
        p.endsWith("package.json") ||
        p.endsWith("src/register.ts"),
    );

    const modules = discoverSideEffectAppModules(["/repo/plugins"]);
    expect(modules).toHaveLength(1);
    expect(modules[0].mode).toBe("register");
    expect(modules[0].key).toContain("#register");
    expect(modules[0].entry).toContain("src/register.ts");
  });

  it("discovers ui-mode plugins with fallback entry candidates", () => {
    mocks.readdirSync.mockReturnValue([
      { name: "plugin-b", isDirectory: () => true },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        name: "@scope/plugin-b",
        elizaos: { appRegister: "ui" },
      }),
    );
    mocks.existsSync.mockImplementation(
      (p: string) =>
        p === "/repo/plugins" ||
        p.endsWith("package.json") ||
        p.endsWith("src/ui/index.ts"),
    );

    const modules = discoverSideEffectAppModules(["/repo/plugins"]);
    expect(modules).toHaveLength(1);
    expect(modules[0].mode).toBe("ui");
    expect(modules[0].entry).toContain("src/ui/index.ts");
  });

  it("skips plugins without the appRegister marker", () => {
    mocks.readdirSync.mockReturnValue([
      { name: "plugin-c", isDirectory: () => true },
    ]);
    mocks.readFileSync.mockReturnValue(JSON.stringify({ name: "plugin-c" }));
    const modules = discoverSideEffectAppModules(["/repo/plugins"]);
    expect(modules).toHaveLength(0);
  });

  it("skips plugins whose declared entry is missing", () => {
    mocks.readdirSync.mockReturnValue([
      { name: "plugin-d", isDirectory: () => true },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify({
        name: "plugin-d",
        elizaos: { appRegister: "register" },
      }),
    );
    mocks.existsSync.mockReturnValue(false);
    const modules = discoverSideEffectAppModules(["/repo/plugins"]);
    expect(modules).toHaveLength(0);
  });
});
