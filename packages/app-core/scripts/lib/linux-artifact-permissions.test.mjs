import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hardenLinuxArtifactPermissions } from "./linux-artifact-permissions.mjs";

test("removes group/other writes while preserving executable files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linux-artifact-mode-"));
  try {
    const executable = path.join(root, "tool");
    const data = path.join(root, "data.json");
    fs.writeFileSync(executable, "#!/bin/sh\n");
    fs.writeFileSync(data, "{}\n");
    fs.chmodSync(root, 0o777);
    fs.chmodSync(executable, 0o777);
    fs.chmodSync(data, 0o666);

    assert.equal(hardenLinuxArtifactPermissions(root), 3);
    assert.equal(fs.statSync(root).mode & 0o777, 0o755);
    assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
    assert.equal(fs.statSync(data).mode & 0o777, 0o644);
    assert.equal(hardenLinuxArtifactPermissions(root), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
