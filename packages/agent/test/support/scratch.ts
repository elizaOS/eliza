// spec/agent/deviceActions/execution.md, "Dispatch needs an exact reservation and the agent's claim"; spec/agent/deviceActions/execution.md, "A settled result is durable before upload and upload never repeats the call"
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A private directory the device-execution driver keeps its journal in, removed when the walk ends. */
export interface Scratch {
  readonly path: string;
  /** @throws {never} */
  file(name: string): string;
  remove(): Promise<void>;
}

export async function scratchDirectory(prefix: string): Promise<Scratch> {
  const path = await realpath(await mkdtemp(join(tmpdir(), `${prefix}-`)));
  return { path, file: (name) => join(path, name), remove: () => rm(path, { recursive: true, force: true }) };
}
