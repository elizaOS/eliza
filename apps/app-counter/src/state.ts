/**
 * Tiny file-backed counter store. The state file lives under the runtime
 * state-dir (`MILADY_STATE_DIR` / `ELIZA_STATE_DIR` if set, else `~/.milady`)
 * so the value survives process restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const STATE_FILE_NAME = "app-counter.json";

function resolveStateDir(): string {
  const envDir =
    process.env.MILADY_STATE_DIR?.trim() ||
    process.env.ELIZA_STATE_DIR?.trim();
  if (envDir && path.isAbsolute(envDir)) return envDir;
  return path.join(homedir(), ".milady");
}

export type CounterState = { count: number };

export class CounterStore {
  private readonly file: string;

  constructor(stateDir: string = resolveStateDir()) {
    this.file = path.join(stateDir, STATE_FILE_NAME);
  }

  get(): number {
    if (!existsSync(this.file)) return 0;
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<CounterState>;
      return typeof parsed.count === "number" && Number.isFinite(parsed.count)
        ? parsed.count
        : 0;
    } catch {
      return 0;
    }
  }

  set(next: number): number {
    const dir = path.dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload: CounterState = { count: next };
    writeFileSync(this.file, JSON.stringify(payload), "utf8");
    return next;
  }

  increment(by = 1): number {
    return this.set(this.get() + by);
  }

  decrement(by = 1): number {
    return this.set(this.get() - by);
  }

  reset(): number {
    return this.set(0);
  }
}
