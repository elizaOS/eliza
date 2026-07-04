// Exercises tests rewrite dist relative imports node esm.test automation behavior with deterministic script fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../rewrite-dist-relative-imports-node-esm.mjs", import.meta.url),
);

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rewrite-dist-esm-"));
  tempRoots.push(root);
  write(
    root,
    "package.json",
    JSON.stringify({ type: "module", workspaces: ["packages/*"] }, null, 2),
  );
  return root;
}

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("rewrite-dist-relative-imports-node-esm", () => {
  test("rewrites TypeScript source extensions in emitted declaration files", () => {
    const root = makeRepo();
    write(root, "packages/example/dist/actions/display-text.js", "");
    write(root, "packages/example/dist/actions/display-text.d.ts", "");
    write(root, "packages/example/dist/ui/widget.js", "");
    write(root, "packages/example/dist/ui/widget.d.ts", "");
    write(root, "packages/example/dist/folder/index.js", "");
    write(
      root,
      "packages/example/dist/index.d.ts",
      [
        'export { display } from "./actions/display-text.ts";',
        'export type { Widget } from "./ui/widget.tsx";',
        'export * from "./folder";',
        'export type { External } from "@elizaos/core";',
      ].join("\n"),
    );
    write(
      root,
      "packages/example/dist/runtime.js",
      [
        'import { display } from "./actions/display-text.ts";',
        'const modulePromise = import("./ui/widget.tsx");',
        "export { display, modulePromise };",
      ].join("\n"),
    );

    const result = spawnSync("node", [scriptPath, "packages/example"], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }

    const declaration = fs.readFileSync(
      path.join(root, "packages/example/dist/index.d.ts"),
      "utf8",
    );
    expect(declaration).toContain(
      'export { display } from "./actions/display-text.js";',
    );
    expect(declaration).toContain(
      'export type { Widget } from "./ui/widget.js";',
    );
    expect(declaration).toContain('export * from "./folder/index.js";');
    expect(declaration).toContain(
      'export type { External } from "@elizaos/core";',
    );

    const runtime = fs.readFileSync(
      path.join(root, "packages/example/dist/runtime.js"),
      "utf8",
    );
    expect(runtime).toContain(
      'import { display } from "./actions/display-text.js";',
    );
    expect(runtime).toContain('import("./ui/widget.js")');
  });
});
