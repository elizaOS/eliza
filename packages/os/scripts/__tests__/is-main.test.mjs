import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../distro-android/is-main.mjs";

test("entry-point helper honors explicit runtime decisions", () => {
  assert.equal(isMainModule({ main: false }), false);
  assert.equal(isMainModule({ main: true }), true);
});

test("fallback executes a symlinked entry point but not an imported module", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "os-cli-entry-"));
  try {
    const helper = new URL("../distro-android/is-main.mjs", import.meta.url)
      .href;
    const entry = join(root, "entry.mjs");
    const link = join(root, "linked.mjs");
    const importer = join(root, "importer.mjs");
    writeFileSync(
      entry,
      `import {isMainModule} from ${JSON.stringify(helper)}; if(isMainModule({url:import.meta.url})) process.stdout.write('ran');`,
    );
    symlinkSync(entry, link);
    writeFileSync(
      importer,
      `import ${JSON.stringify(pathToFileURL(entry).href)};`,
    );
    for (const file of [entry, link]) {
      const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "ran");
    }
    const result = spawnSync(process.execPath, [importer], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
