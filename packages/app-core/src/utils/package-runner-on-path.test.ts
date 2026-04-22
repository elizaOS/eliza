import { describe, expect, it } from "vitest";
import { formatPackageRunnerInstallHint } from "./package-runner-on-path";

describe("formatPackageRunnerInstallHint", () => {
  it("mentions Node.js for npx", () => {
    expect(formatPackageRunnerInstallHint("npx")).toMatch(/nodejs\.org/i);
  });

  it("mentions Bun for bunx", () => {
    expect(formatPackageRunnerInstallHint("bunx")).toMatch(/bun\.sh/i);
  });

  it("handles absolute paths", () => {
    expect(formatPackageRunnerInstallHint("/usr/local/bin/npx")).toMatch(
      /nodejs\.org/i,
    );
  });
});
