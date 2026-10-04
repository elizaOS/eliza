import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSourceOverlay } from "./source-overlay.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
test("additive overlays preserve the checkout and reject altered or undeclared source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-contract-"));
  try {
    const checkout = path.join(root, "upstream");
    fs.mkdirSync(checkout);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", checkout, ...args], {
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
    const baseCommit = git("rev-parse", "HEAD");
    fs.writeFileSync(
      path.join(root, "upstream.lock.json"),
      JSON.stringify({ commit: baseCommit }),
    );
    const file = "shared/a.mjs",
      content = "export const a = 1;\n";
    const patch = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${content}`;
    const spec = {
      schemaVersion: 1,
      baseCommit,
      patch: "a.patch",
      patchSha256: hash(patch),
      sourceRoots: ["shared"],
      files: { [file]: hash(content) },
    };
    fs.writeFileSync(path.join(root, "a.patch"), patch);
    const manifest = path.join(root, "a.json");
    fs.writeFileSync(manifest, JSON.stringify(spec));
    const output = path.join(root, "output");
    const options = {
      root,
      checkout: "upstream",
      output,
      manifests: ["a.json"],
      accepts: (name: string) => name.endsWith(".mjs"),
    };
    const overlay = createSourceOverlay(options);
    overlay.stage();
    assert.deepEqual(overlay.verify(), [path.join(output, "shared")]);
    const before = fs.statSync(path.join(output, file)).ino;
    overlay.stage();
    assert.equal(fs.statSync(path.join(output, file)).ino, before);
    fs.appendFileSync(path.join(output, file), "modified");
    assert.throws(() => overlay.verify(), /inventory mismatch/);
    overlay.stage();
    fs.writeFileSync(path.join(output, "extra.mjs"), "extra");
    assert.throws(() => overlay.verify(), /inventory mismatch/);
    overlay.stage();
    fs.symlinkSync(path.join(root, "a.patch"), path.join(output, "link"));
    assert.throws(() => overlay.verify(), /links/);
    overlay.stage();
    fs.writeFileSync(path.join(output, "provenance.json"), "{}");
    assert.throws(() => overlay.verify(), /provenance mismatch/);
    overlay.stage();
    assert.throws(
      () =>
        createSourceOverlay({
          ...options,
          manifests: ["a.json", "a.json"],
          compose: true,
        }).stage(),
      /replace each other/,
    );
    fs.writeFileSync(
      manifest,
      JSON.stringify({ ...spec, patch: "../outside.patch" }),
    );
    assert.throws(() => overlay.stage(), /source path/);
    fs.writeFileSync(
      manifest,
      JSON.stringify({ ...spec, baseCommit: "wrong" }),
    );
    assert.throws(() => overlay.stage(), /base pin/);
    fs.writeFileSync(
      manifest,
      JSON.stringify({ ...spec, patchSha256: "0".repeat(64) }),
    );
    assert.throws(() => overlay.stage(), /patch hash/);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(git("rev-parse", "HEAD"), baseCommit);
    assert.equal(fs.existsSync(output + ".lock"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
