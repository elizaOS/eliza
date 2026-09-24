import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeAospKeymasterInit } from "../distro-android/prepare-grizzly.ts";

test("keymaster diagnostic is reversible and never changes pinned init source", () => {
  const root = mkdtempSync(join(tmpdir(), "keymaster-overlay-"));
  try {
    const source = join(root, "system/core/rootdir/init.rc");
    const generated = join(root, "vendor/google_devices/grizzly");
    mkdirSync(join(root, "system/core/rootdir"), { recursive: true });
    mkdirSync(generated, { recursive: true });
    const original =
      "on post-fs-data\n    exec - system system -- /system/bin/vdc keymaster earlyBootEnded\n";
    writeFileSync(source, original);
    const makefile = join(generated, "grizzly.mk");
    writeFileSync(makefile, "# stock\n");
    normalizeAospKeymasterInit(root, true);
    normalizeAospKeymasterInit(root, true);
    assert.equal(readFileSync(source, "utf8"), original);
    assert.equal(
      (readFileSync(makefile, "utf8").match(/PRODUCT_COPY_FILES/g) ?? [])
        .length,
      1,
    );
    normalizeAospKeymasterInit(root, false);
    assert.doesNotMatch(
      readFileSync(makefile, "utf8"),
      /diagnostic|PRODUCT_COPY_FILES/,
    );
    assert.equal(
      existsSync(join(generated, "diagnostics/system/etc/init/hw/init.rc")),
      false,
    );
    assert.equal(readFileSync(source, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
