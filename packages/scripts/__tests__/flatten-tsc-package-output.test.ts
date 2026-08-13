/**
 * Verifies flatten-tsc-package-output merges nested tsc output into dist
 * without destroying sibling bundler-owned files that share a subdirectory
 * name with the tsc declarations. Runs the real script as a subprocess
 * against a deterministic temp workspace.
 */
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(testDir, "..", "flatten-tsc-package-output.mjs");
const cleanupHelperPath = join(testDir, "..", "rm-path-recursive.mjs");

// These contracts spawn a second Bun process and can outlive Vitest's 5-second
// default when the shared CI host is saturated. Keep the bound explicit while
// allowing the subprocess enough time to reach the filesystem assertions.
const SUBPROCESS_TEST_TIMEOUT_MS = 15_000;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeFixture(root: string, relativePath: string, contents: string) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

// The script resolves the workspace root by walking up from cwd to the first
// package.json with a `workspaces` key, then invokes
// packages/scripts/rm-path-recursive.mjs relative to that root — so the fake
// workspace needs both the manifest and a copy of the cleanup helper.
function createFakeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "eliza-flatten-tsc-"));
  temporaryDirectories.push(root);
  writeFixture(
    root,
    "package.json",
    JSON.stringify({ workspaces: ["packages/*"] }),
  );
  mkdirSync(join(root, "packages", "scripts"), { recursive: true });
  copyFileSync(
    cleanupHelperPath,
    join(root, "packages", "scripts", "rm-path-recursive.mjs"),
  );
  return root;
}

async function runFlatten(root: string, packageDir: string) {
  await execFileAsync(process.execPath, [scriptPath, packageDir], {
    cwd: root,
  });
}

describe("flatten-tsc-package-output", {
  timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
  test("directory merge preserves pre-existing sibling files while adding tsc output", async () => {
    const root = createFakeWorkspace();
    const dist = join(root, "packages", "demo", "dist");

    // Bundler-owned file already in dist/workers before the flatten runs.
    writeFixture(
      root,
      "packages/demo/dist/workers/app-worker-entry.js",
      "bundler output\n",
    );
    // Nested tsc output sharing the `workers` subdirectory name.
    writeFixture(
      root,
      "packages/demo/dist/packages/demo/src/workers/app-worker.d.ts",
      "export declare const worker: string;\n",
    );
    writeFixture(
      root,
      "packages/demo/dist/packages/demo/src/index.js",
      "flattened entry\n",
    );

    await runFlatten(root, "packages/demo");

    expect(
      readFileSync(join(dist, "workers", "app-worker-entry.js"), "utf8"),
    ).toBe("bundler output\n");
    expect(readFileSync(join(dist, "workers", "app-worker.d.ts"), "utf8")).toBe(
      "export declare const worker: string;\n",
    );
    expect(readFileSync(join(dist, "index.js"), "utf8")).toBe(
      "flattened entry\n",
    );
    expect(existsSync(join(dist, "packages"))).toBe(false);
  });

  test("a flattened file replaces a stale same-name file", async () => {
    const root = createFakeWorkspace();
    const dist = join(root, "packages", "demo", "dist");

    writeFixture(root, "packages/demo/dist/index.js", "stale\n");
    writeFixture(root, "packages/demo/dist/nested/inner.js", "stale inner\n");
    writeFixture(
      root,
      "packages/demo/dist/packages/demo/src/index.js",
      "fresh\n",
    );
    writeFixture(
      root,
      "packages/demo/dist/packages/demo/src/nested/inner.js",
      "fresh inner\n",
    );

    await runFlatten(root, "packages/demo");

    expect(readFileSync(join(dist, "index.js"), "utf8")).toBe("fresh\n");
    expect(readFileSync(join(dist, "nested", "inner.js"), "utf8")).toBe(
      "fresh inner\n",
    );
  });

  test("a same-name file blocking a directory merge is cleared", async () => {
    const root = createFakeWorkspace();
    const dist = join(root, "packages", "demo", "dist");

    // dist/nested exists so the top-level entry takes the merge path, and
    // dist/nested/types is a FILE where tsc output needs a directory.
    writeFixture(root, "packages/demo/dist/nested/keep.js", "keep\n");
    writeFixture(root, "packages/demo/dist/nested/types", "blocking file\n");
    writeFixture(
      root,
      "packages/demo/dist/packages/demo/src/nested/types/index.d.ts",
      "export type Demo = string;\n",
    );
    writeFixture(
      root,
      "packages/demo/dist/packages/demo/src/index.js",
      "entry\n",
    );

    await runFlatten(root, "packages/demo");

    expect(statSync(join(dist, "nested", "types")).isDirectory()).toBe(true);
    expect(
      readFileSync(join(dist, "nested", "types", "index.d.ts"), "utf8"),
    ).toBe("export type Demo = string;\n");
    expect(readFileSync(join(dist, "nested", "keep.js"), "utf8")).toBe(
      "keep\n",
    );
  });
});
