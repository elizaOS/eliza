/**
 * Pins the executable-search authority contract shared by the ACP, one-shot,
 * and TUI entrypoints. Importing the capture module produces a real PATH
 * baseline, and both executable entries keep that module as their first import
 * so no runtime module body can beat it. Deterministic; no live runtime.
 */
import { readFileSync } from "node:fs";
import {
  getHostExecutionBaseline,
  resolveHostExecutable,
} from "@elizaos/shared/host-execution-env";
import { describe, expect, it } from "vitest";

describe("eliza-code host execution baseline", () => {
  it("captures a non-empty PATH baseline via the side-effect module", async () => {
    await import("./host-baseline.js");
    const baseline = getHostExecutionBaseline();
    expect(baseline.path).toBeDefined();
    expect(baseline.path).toContain("/");
    expect(resolveHostExecutable(process.execPath)).toBe(process.execPath);
  });

  it.each(["acp.ts", "index.ts"])(
    "keeps host-baseline as the FIRST import of %s",
    (entry) => {
      const source = readFileSync(
        new URL(`./${entry}`, import.meta.url),
        "utf8",
      );
      const firstImport = source.match(/^import .*$/m)?.[0] ?? "";
      expect(firstImport).toBe('import "./host-baseline.js";');
    },
  );
});
