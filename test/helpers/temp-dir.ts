import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTempDirManager(prefix: string) {
  const tempDirs: string[] = [];

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function cleanupTempDirs() {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return { makeTempDir, cleanupTempDirs };
}
