/**
 * Pins the ACP child's executable-search authority contract: importing the
 * entry's first module captures a real PATH baseline, and acp.ts keeps
 * host-baseline as its FIRST import so no runtime module body can beat it.
 * Deterministic; no live runtime.
 */
import { readFileSync } from "node:fs";
import { getHostExecutionBaseline } from "@elizaos/shared/host-execution-env";
import { describe, expect, it } from "vitest";

describe("acp host execution baseline", () => {
  it("captures a non-empty PATH baseline via the side-effect module", async () => {
    await import("./host-baseline.js");
    const baseline = getHostExecutionBaseline();
    expect(baseline.path).toBeDefined();
    expect(baseline.path).toContain("/");
  });

  it("keeps host-baseline as the FIRST import of the acp entry", () => {
    const source = readFileSync(new URL("./acp.ts", import.meta.url), "utf8");
    const firstImport = source.match(/^import .*$/m)?.[0] ?? "";
    expect(firstImport).toBe('import "./host-baseline.js";');
  });
});
