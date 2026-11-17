// spec/core/runtime.md, "Story: Initialize an explicit host composition"; spec/core/runtime.md, "Story: Retire every owned operation"
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeScratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

export function removeScratch(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}
