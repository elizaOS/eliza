/**
 * Verifies the hosted staging proof actually lacks ordinary directory-symlink
 * access. A successful symlink invalidates the proof prerequisite; junction
 * behavior is exercised separately by the real staging consumer tests.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

assert.equal(process.platform, "win32", "This proof requires actual Windows");
assert.equal(process.versions.node, "24.15.0", "Use the pinned Node runtime");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "staging-symlink-probe-"));
try {
  const target = path.join(root, "target");
  await fs.mkdir(target);
  await assert.rejects(fs.symlink(target, path.join(root, "alias"), "dir"), {
    code: "EPERM",
  });
  process.stdout.write("Ordinary directory symlink denied with EPERM.\n");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
