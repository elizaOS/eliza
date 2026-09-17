/** Exercises the actual dependency installer in temporary Git checkouts, including partial installs and hardlinked package isolation. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const installer = new URL("./patch-llama-cpp-capacitor.mjs", import.meta.url);
const patch = `diff --git a/dist/esm/index.js b/dist/esm/index.js
--- a/dist/esm/index.js
+++ b/dist/esm/index.js
@@ -1 +1,2 @@
 export const legacy = 1;
+export const embedding = 2;
diff --git a/types/llama-cpp-capacitor.d.ts b/types/llama-cpp-capacitor.d.ts
--- a/types/llama-cpp-capacitor.d.ts
+++ b/types/llama-cpp-capacitor.d.ts
@@ -1,3 +1,4 @@
 declare module 'llama-cpp-capacitor' {
   export const legacy: number;
+  export const embedding: number;
 }
`;
const initial = {
  "android/src/main/CMakeLists.txt": "project(llama-cpp-capacitor-eliza-mtp)\n",
  "dist/esm/index.js": "export const legacy = 1;\n",
  "types/llama-cpp-capacitor.d.ts":
    "declare module 'llama-cpp-capacitor' {\n  export const legacy: number;\n}\n",
};
const expected = {
  ...initial,
  "dist/esm/index.js":
    "export const legacy = 1;\nexport const embedding = 2;\n",
  "types/llama-cpp-capacitor.d.ts":
    "declare module 'llama-cpp-capacitor' {\n  export const legacy: number;\n  export const embedding: number;\n}\n",
};
for (const mode of [
  "existing Android",
  "partial bridge",
  "hardlinked",
  "corrupt",
]) {
  test(`installer admits ${mode} package without silent omissions`, () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-dependency-patch-"),
    );
    try {
      const script = path.join(
        root,
        "packages/scripts/patch-llama-cpp-capacitor.mjs",
      );
      const pkg = path.join(root, "node_modules/llama-cpp-capacitor");
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.copyFileSync(installer, script);
      fs.mkdirSync(path.join(root, "patches"));
      fs.writeFileSync(
        path.join(root, "patches/llama-cpp-capacitor@0.1.5.patch"),
        patch,
      );
      assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
      for (const [relative, value] of Object.entries(initial)) {
        const file = path.join(pkg, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, value);
      }
      if (mode === "partial bridge")
        fs.writeFileSync(
          path.join(pkg, "dist/esm/index.js"),
          expected["dist/esm/index.js"],
        );
      if (mode === "corrupt")
        fs.writeFileSync(
          path.join(pkg, "dist/esm/index.js"),
          "incompatible upstream\n",
        );
      const sibling = path.join(root, "untouched-install");
      if (mode === "hardlinked") {
        for (const relative of Object.keys(initial)) {
          const link = path.join(sibling, relative);
          fs.mkdirSync(path.dirname(link), { recursive: true });
          fs.linkSync(path.join(pkg, relative), link);
          assert.equal(fs.statSync(link).nlink, 2);
        }
      }
      const run = () =>
        spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      const first = run();
      if (mode === "corrupt") {
        assert.equal(first.status, 1);
        assert.match(first.stderr, /neither applicable nor verified/);
        return;
      }
      assert.equal(first.status, 0, first.stderr);
      for (const [relative, value] of Object.entries(expected))
        assert.equal(fs.readFileSync(path.join(pkg, relative), "utf8"), value);
      const second = run();
      assert.equal(second.status, 0, second.stderr);
      for (const [relative, value] of Object.entries(expected))
        assert.equal(fs.readFileSync(path.join(pkg, relative), "utf8"), value);
      if (mode === "hardlinked") {
        for (const [relative, value] of Object.entries(initial))
          assert.equal(
            fs.readFileSync(path.join(sibling, relative), "utf8"),
            value,
          );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
