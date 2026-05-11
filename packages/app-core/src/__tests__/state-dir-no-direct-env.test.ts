/**
 * Guard: no callsite in `packages/app-core/src/` reads `ELIZA_STATE_DIR` /
 * `MILADY_STATE_DIR` without going through `resolveStateDir()` or pairing both
 * env vars in the same window. The canonical resolver lives in
 * `@elizaos/core/utils/state-dir.ts` and honors the documented precedence
 * `MILADY_STATE_DIR > ELIZA_STATE_DIR > ~/.${ELIZA_NAMESPACE ?? "eliza"}`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
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
  it("no callsite reads ELIZA_STATE_DIR without honoring MILADY_STATE_DIR in the same window", () => {
    const files = walkSrc(APP_CORE_SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // Match either `process.env.ELIZA_STATE_DIR` or `env.ELIZA_STATE_DIR`,
        // but NOT inside a comment line (// or *).
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (
          !/process\.env\.ELIZA_STATE_DIR\b/.test(line) &&
          !/\benv\.ELIZA_STATE_DIR\b/.test(line)
        ) {
          continue;
        }
        // Check a 5-line window for MILADY_STATE_DIR pairing OR resolveStateDir usage.
        const windowStart = Math.max(0, i - 2);
        const windowEnd = Math.min(lines.length, i + 3);
        const window = lines.slice(windowStart, windowEnd).join("\n");
        if (
          window.includes("MILADY_STATE_DIR") ||
          window.includes("resolveStateDir")
        ) {
          continue;
        }
        offenders.push(`${file}:${i + 1}: ${trimmed}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
