/** Execute compiled multi-file plugins from real project storage. */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { PluginCompiler } from "../src/services/plugin-compiler.ts";
import { VirtualFilesystemService } from "../src/services/virtual-filesystem.ts";

it.each(["esm", "cjs"] as const)(
  "compiles and executes a %s dependency graph; failure preserves the published file",
  async (format) => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-compile-"));
    try {
      const vfs = new VirtualFilesystemService({
        stateDir: dir,
        projectId: "compiler",
      });
      await vfs.writeFile("src/value.ts", "export const value: number = 42;");
      await vfs.writeFile(
        "src/plugin.ts",
        'import { value } from "./value.ts"; console.log(value);',
      );
      const outFile = `dist/plugin.${format === "esm" ? "mjs" : "cjs"}`;
      const compiler = new PluginCompiler();
      await compiler.compile({ vfs, entry: "src/plugin.ts", outFile, format });
      const child = spawnSync("node", [vfs.resolveDiskPath(outFile)], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe("42");
      const before = await vfs.readFile(outFile);
      await vfs.writeFile("src/value.ts", "export const value = ;");
      await expect(
        compiler.compile({ vfs, entry: "src/plugin.ts", outFile, format }),
      ).rejects.toMatchObject({ code: "PLUGIN_COMPILATION_FAILED" });
      expect(await vfs.readFile(outFile)).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
