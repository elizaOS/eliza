/** Exercises dev platform no install behavior with deterministic app-core test fixtures. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "dev-platform.mjs",
);

describe("dev-platform API child command", () => {
  it("disables Bun auto-install for the runtime process", () => {
    const source = readFileSync(scriptPath, "utf8");

    expect(source).toContain(
      'const apiSourceConditionArgs = ["--no-install", "--conditions=eliza-source"];',
    );
  });
});
