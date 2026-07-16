import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

function testTmpRoot() {
  if (process.env.TEST_TMPDIR) return process.env.TEST_TMPDIR;
  if (process.env.ELIZA_TMP_ROOT) return process.env.ELIZA_TMP_ROOT;
  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, "eliza-hub", "tmp", "test");
  }

  const home = process.env.HOME || homedir();
  if (home) return path.join(home, ".cache", "eliza-hub", "tmp", "test");

  return path.join("/var/tmp", "eliza-hub", "tmp", "test");
}

export async function mkdtempInTestRoot(prefix) {
  const root = testTmpRoot();
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, prefix));
}

export function mkdtempSyncInTestRoot(prefix) {
  const root = testTmpRoot();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, prefix));
}
