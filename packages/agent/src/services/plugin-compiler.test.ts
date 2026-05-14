import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginCompiler } from "./plugin-compiler.ts";
import {
  VirtualFilesystemError,
  VirtualFilesystemService,
} from "./virtual-filesystem.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-plugin-compiler-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function vfs(projectId = "compiler-test") {
  return new VirtualFilesystemService({
    projectId,
    stateDir: tmpDir,
    quotaBytes: 4 * 1024 * 1024,
    maxFileBytes: 2 * 1024 * 1024,
  });
}

const TINY_PLUGIN_TS = `
export default {
  name: "tiny-vfs-plugin",
  description: "A trivial plugin compiled from VFS for testing.",
  actions: [
    {
      name: "TINY_VFS_PING",
      description: "responds with pong",
      examples: [],
      similes: [],
      validate: async () => true,
      handler: async () => ({ pong: true }),
    },
  ],
};
`;

describe("PluginCompiler", () => {
  it("compiles a tiny TS plugin from VFS to VFS and the output is importable ESM", async () => {
    const filesystem = vfs();
    await filesystem.initialize();
    await filesystem.writeFile("src/plugin.ts", TINY_PLUGIN_TS);

    const compiler = new PluginCompiler();
    const result = await compiler.compile({
      vfs: filesystem,
      entry: "src/plugin.ts",
    });

    expect(result.outFile).toBe("/dist/plugin.js");
    expect(result.format).toBe("esm");
    expect(result.warnings).toEqual([]);

    const compiled = await filesystem.readFile("dist/plugin.js");
    expect(compiled.length).toBeGreaterThan(0);
    expect(compiled).toContain("tiny-vfs-plugin");

    const diskPath = filesystem.resolveDiskPath("dist/plugin.js");
    const moduleUrl = `${pathToFileURL(diskPath).href}?t=${Date.now()}`;
    const mod = (await import(moduleUrl)) as {
      default?: { name?: string; actions?: Array<{ name?: string }> };
    };

    expect(mod.default).toBeDefined();
    expect(mod.default?.name).toBe("tiny-vfs-plugin");
    expect(Array.isArray(mod.default?.actions)).toBe(true);
    expect(mod.default?.actions?.[0]?.name).toBe("TINY_VFS_PING");
  });

  it("rejects path traversal entries via the VFS", async () => {
    const filesystem = vfs();
    await filesystem.initialize();

    const compiler = new PluginCompiler();
    await expect(
      compiler.compile({ vfs: filesystem, entry: "../escape.ts" }),
    ).rejects.toBeInstanceOf(VirtualFilesystemError);
  });

  it("does not inline @elizaos/* peers — they remain as ESM imports", async () => {
    const filesystem = vfs("compiler-externals");
    await filesystem.initialize();
    await filesystem.writeFile(
      "src/plugin.ts",
      `
import type { Plugin } from "@elizaos/core";
const plugin: Plugin = {
  name: "external-test-plugin",
  description: "Verifies @elizaos/core stays external.",
};
export default plugin;
`,
    );

    const compiler = new PluginCompiler();
    const result = await compiler.compile({
      vfs: filesystem,
      entry: "src/plugin.ts",
    });

    const compiled = await filesystem.readFile(result.outFile);
    // Type-only imports should be erased entirely. Add a runtime import to
    // confirm externalization keeps the import statement intact rather than
    // inlining @elizaos/core's source.
    await filesystem.writeFile(
      "src/runtime-import.ts",
      `
import { Service } from "@elizaos/core";
export default {
  name: "external-runtime-test-plugin",
  description: "uses a runtime import",
  Service,
};
`,
    );
    const runtimeResult = await compiler.compile({
      vfs: filesystem,
      entry: "src/runtime-import.ts",
      outFile: "dist/runtime-import.js",
    });
    const runtimeCompiled = await filesystem.readFile(runtimeResult.outFile);
    expect(runtimeCompiled).toMatch(/from\s+["']@elizaos\/core["']/);
    // sanity: no inlined elizaos/core class definition body
    expect(runtimeCompiled).not.toMatch(/class\s+AgentRuntime\b/);
    void compiled;
  });
});
