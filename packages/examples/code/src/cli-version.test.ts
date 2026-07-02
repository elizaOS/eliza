// @vitest-environment node

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { main } from "./cli.js";

function packageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

describe("eliza-code CLI version (#11294)", () => {
  it("prints the package.json version for --version", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };

    try {
      const exitCode = await main(["--version"]);
      expect(exitCode).toBe(0);
      expect(lines).toEqual([`eliza-code v${packageVersion()}`]);
    } finally {
      console.log = originalLog;
    }
  });
});
