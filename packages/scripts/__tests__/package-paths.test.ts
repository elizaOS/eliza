import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("loads package-path helpers without runtime packages or build outputs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "testing-paths-"));
  try {
    fs.mkdirSync(path.join(dir, "lib"));
    const { name, type, exports } = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    // Preserve self-resolution without declaring installable dependencies:
    // Bun can otherwise resolve core from its package cache in this fixture.
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, type, exports }),
    );
    fs.copyFileSync(
      new URL("../lib/package-paths.ts", import.meta.url),
      path.join(dir, "lib/package-paths.ts"),
    );
    for (const file of ["index.ts", "test-output.ts"])
      fs.copyFileSync(
        new URL(`../lib/${file}`, import.meta.url),
        path.join(dir, "lib", file),
      );
    fs.writeFileSync(
      path.join(dir, "probe.mjs"),
      `
      import assert from "node:assert/strict";
      import { getElizaCoreEntry, resolveModuleEntry } from "@elizaos/repository-tools";
      assert.equal(typeof resolveModuleEntry, "function");
      assert.equal(getElizaCoreEntry(process.cwd()), undefined);
    `,
    );
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const runtimeArgs = process.versions.bun ? ["--no-install"] : [];
    const result = spawnSync(
      process.execPath,
      [...runtimeArgs, path.join(dir, "probe.mjs")],
      {
        cwd: dir,
        env,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
