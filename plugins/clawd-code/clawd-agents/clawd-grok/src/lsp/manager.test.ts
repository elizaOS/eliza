import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspClientSession } from "./client";
import { createWorkspaceLspManager } from "./manager";
import type { NormalizedLspSettings } from "./types";

const BASE_SETTINGS: NormalizedLspSettings = {
  enabled: true,
  tool: true,
  autoInstall: false,
  startupTimeoutMs: 5_000,
  diagnosticsDebounceMs: 0,
  builtins: {
    typescript: {
      enabled: false,
    },
  },
  servers: [
    {
      id: "fake-ts",
      command: "fake-lsp",
      extensions: [".ts"],
      languageIds: {
        ".ts": "typescript",
      },
      rootMarkers: [".git"],
    },
  ],
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createWorkspaceLspManager", () => {
  it("routes queries through the matching LSP client", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "src", "demo.ts");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "const demo = 1;\n");

    const sendRequest = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe("textDocument/definition");
      expect(params).toMatchObject({
        position: {
          line: 4,
          character: 2,
        },
      });
      return [{ uri: "file:///demo.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } }];
    });
    const client = createFakeClient({ sendRequest });

    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, {
      createClient: async () => client,
    });

    const result = await manager.query({
      operation: "goToDefinition",
      filePath,
      line: 5,
      character: 3,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("file:///demo.ts");
    expect(client.openOrChangeFile).toHaveBeenCalledWith(filePath, "typescript", "const demo = 1;\n");
    expect(client.waitForDiagnostics).toHaveBeenCalledWith(filePath);

    await manager.close();
    expect(client.stop).toHaveBeenCalled();
  });

  it("returns diagnostics after syncing a saved file", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.ts");
    const diagnostics = [
      {
        filePath,
        serverId: "fake-ts",
        diagnostics: [
          {
            message: "Type error",
            severity: 1,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 4 },
            },
          },
        ],
      },
    ];

    const client = createFakeClient({
      diagnostics: diagnostics[0].diagnostics,
    });

    const manager = createWorkspaceLspManager(root, BASE_SETTINGS, {
      createClient: async () => client,
    });

    const result = await manager.syncFile(filePath, "const broken = true;\n", true, true);

    expect(result).toEqual(diagnostics);
    expect(client.saveFile).toHaveBeenCalledWith(filePath);
    expect(client.waitForDiagnostics).toHaveBeenCalledWith(filePath);

    await manager.close();
  });

  it("reports when no matching server exists", async () => {
    const root = await createTempWorkspace();
    const filePath = path.join(root, "demo.rb");
    await writeFile(filePath, "puts 'hello'\n");

    const manager = createWorkspaceLspManager(root, { ...BASE_SETTINGS, servers: [] });
    const result = await manager.query({
      operation: "hover",
      filePath,
      line: 1,
      character: 1,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("No LSP server available");

    await manager.close();
  });
});

async function createTempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-lsp-manager-"));
  tempDirs.push(root);
  await mkdir(path.join(root, ".git"), { recursive: true });
  return root;
}

function createFakeClient(input: {
  diagnostics?: LspClientSession["getDiagnostics"] extends (filePath: string) => infer TResult ? TResult : never;
  sendRequest?: (method: string, params: unknown) => Promise<unknown>;
}): LspClientSession & {
  openOrChangeFile: ReturnType<typeof vi.fn>;
  saveFile: ReturnType<typeof vi.fn>;
  waitForDiagnostics: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const diagnostics = input.diagnostics ?? [];
  return {
    serverId: "fake-ts",
    root: "/tmp",
    openOrChangeFile: vi.fn(async () => {}),
    saveFile: vi.fn(async () => {}),
    closeFile: vi.fn(async () => {}),
    sendRequest: (async <TResult>(method: string, params: unknown) =>
      (input.sendRequest ? await input.sendRequest(method, params) : []) as TResult) as LspClientSession["sendRequest"],
    waitForDiagnostics: vi.fn(async () => diagnostics),
    getDiagnostics: vi.fn(() => diagnostics),
    stop: vi.fn(async () => {}),
  };
}
