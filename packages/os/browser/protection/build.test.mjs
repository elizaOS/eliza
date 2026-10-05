import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeProtectionAssets } from "./build.mjs";

test("independent consumers supply warning skins without replacing enforcement or widening capabilities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "protection-consumer-"));
  try {
    await writeFile(
      join(directory, "warning.html"),
      "<h1>Consumer warning</h1>",
    );
    await writeFile(join(directory, "warning.css"), "h1 { font-size: 2rem; }");
    // An override directory cannot replace worker or messaging code.
    await writeFile(
      join(directory, "background.mjs"),
      'throw new Error("wrong worker")',
    );
    const original = {
      "manifest.json": Buffer.from(
        JSON.stringify({ permissions: ["storage", "tabs"] }),
      ),
      "background.mjs": Buffer.from("// host worker"),
    };
    const custom = await composeProtectionAssets(original, {
      warningDirectory: directory,
    });
    const standard = await composeProtectionAssets(original);
    assert.equal(
      custom["warning.html"].toString(),
      "<h1>Consumer warning</h1>",
    );
    assert.notDeepEqual(custom["warning.html"], standard["warning.html"]);
    assert.deepEqual(custom["protection.mjs"], standard["protection.mjs"]);
    assert.deepEqual(custom["policy.mjs"], standard["policy.mjs"]);
    const manifest = JSON.parse(custom["manifest.json"]);
    assert.deepEqual(manifest.permissions, [
      "storage",
      "tabs",
      "declarativeNetRequest",
    ]);
    assert.deepEqual(manifest.web_accessible_resources, [
      { resources: ["warning.html"], matches: ["<all_urls>"] },
    ]);
    assert.deepEqual(JSON.parse(original["manifest.json"]).permissions, [
      "storage",
      "tabs",
    ]);
    await assert.rejects(composeProtectionAssets(custom), /pre-existing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
