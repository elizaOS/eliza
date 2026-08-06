import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./npm-cache", () => ({
  lspNpmWhich: vi.fn(async () => null),
}));

const { createRuntimeLspDefinitions } = await import("./builtins");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createRuntimeLspDefinitions", () => {
  it("includes all built-in definitions when no overrides are set", () => {
    const defs = createRuntimeLspDefinitions("/tmp", {
      enabled: true,
      tool: true,
      autoInstall: false,
      startupTimeoutMs: 5000,
      diagnosticsDebounceMs: 0,
      builtins: {},
      servers: [],
    });

    const ids = defs.map((d) => d.id);
    expect(ids).toContain("typescript");
    expect(ids).toContain("pyright");
    expect(ids).toContain("gopls");
    expect(ids).toContain("rust-analyzer");
  });

  it("excludes a built-in when disabled via settings", () => {
    const defs = createRuntimeLspDefinitions("/tmp", {
      enabled: true,
      tool: true,
      autoInstall: false,
      startupTimeoutMs: 5000,
      diagnosticsDebounceMs: 0,
      builtins: {
        typescript: { enabled: false },
      },
      servers: [],
    });

    const ids = defs.map((d) => d.id);
    expect(ids).not.toContain("typescript");
    expect(ids).toContain("pyright");
  });

  it("includes custom server definitions", () => {
    const defs = createRuntimeLspDefinitions("/tmp", {
      enabled: true,
      tool: true,
      autoInstall: false,
      startupTimeoutMs: 5000,
      diagnosticsDebounceMs: 0,
      builtins: {},
      servers: [
        {
          id: "custom-lsp",
          command: "custom-server",
          extensions: [".xyz"],
        },
      ],
    });

    const custom = defs.find((d) => d.id === "custom-lsp");
    expect(custom).toBeDefined();
    expect(custom!.extensions).toEqual([".xyz"]);
  });

  it("resolves root using nearest marker from the file upward", async () => {
    const workspace = await createTempWorkspace();
    const nestedDir = path.join(workspace, "packages", "core", "src");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(workspace, "packages", "core", "tsconfig.json"), "{}");

    const defs = createRuntimeLspDefinitions(workspace, {
      enabled: true,
      tool: true,
      autoInstall: false,
      startupTimeoutMs: 5000,
      diagnosticsDebounceMs: 0,
      builtins: {},
      servers: [],
    });

    const tsDef = defs.find((d) => d.id === "typescript")!;
    const root = await tsDef.resolveRoot(path.join(nestedDir, "index.ts"), workspace);
    expect(root).toBe(path.join(workspace, "packages", "core"));
  });
});

async function createTempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-lsp-builtins-"));
  tempDirs.push(root);
  await mkdir(path.join(root, ".git"), { recursive: true });
  return root;
}
