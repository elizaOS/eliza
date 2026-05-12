/**
 * Guard: stale state-dir alias migrations should not leave duplicate fallback
 * chains such as `ELIZA_STATE_DIR || ELIZA_STATE_DIR` in app-core source.
 * The canonical resolver lives in `@elizaos/core/utils/state-dir.ts` and
 * honors `ELIZA_STATE_DIR > ~/.${ELIZA_NAMESPACE ?? "eliza"}`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_CORE_SRC = fileURLToPath(new URL("..", import.meta.url));

function walkSrc(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (
          name === "node_modules" ||
          name === "dist" ||
          name === "__tests__" ||
          name === "__stubs__" ||
          name === ".turbo"
        ) {
          continue;
        }
        stack.push(full);
      } else if (extname(name) === ".ts" && !name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  }
  return out;
}

describe("state-dir consolidation", () => {
  it("does not contain duplicate ELIZA_STATE_DIR fallback chains", () => {
    const files = walkSrc(APP_CORE_SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (!/ELIZA_STATE_DIR[\s\S]*ELIZA_STATE_DIR/.test(line)) continue;
        offenders.push(`${file}:${i + 1}: ${trimmed}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
