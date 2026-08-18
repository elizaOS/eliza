/**
 * Pins executable-search authority for the ACP, one-shot, and TUI entrypoints.
 * The normal entry captures immediately; the warm ACP bootstrap removes its
 * authenticator before loading dependencies and captures only after claim.
 * Deterministic; no live runtime.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { getHostExecutionBaseline } from "@elizaos/shared/host-execution-env";
import { describe, expect, it } from "vitest";

describe("eliza-code host execution baseline", () => {
  it("captures a non-empty PATH baseline via the side-effect module", async () => {
    const previousPath = process.env.PATH;
    const executableDirectory = dirname(process.execPath);
    process.env.PATH = executableDirectory;
    try {
      await import("./host-baseline.js");
      expect(getHostExecutionBaseline().path).toBe(executableDirectory);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it.each([
    ["acp.ts", 'import { consumeWarmClaimToken } from "./acp-bootstrap.js";'],
    ["index.ts", 'import "./host-baseline.js";'],
  ])(
    "keeps the authority bootstrap as the FIRST import of %s",
    (entry, expected) => {
      const source = readFileSync(
        new URL(`./${entry}`, import.meta.url),
        "utf8",
      );
      const firstImport = source.match(/^import .*$/m)?.[0] ?? "";
      expect(firstImport).toBe(expected);
    },
  );

  it("captures the claimed PATH before runtime initialization", () => {
    const acp = readFileSync(new URL("./acp.ts", import.meta.url), "utf8");
    expect(acp.indexOf("warmSessionClaim.apply(params._meta)")).toBeLessThan(
      acp.indexOf("captureHostExecutionBaseline()"),
    );
  });
});
