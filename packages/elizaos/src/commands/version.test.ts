/**
 * Integration coverage for the `version` CLI command's stdout contract: the
 * real command runs against the installed package manifest on disk with no
 * module mocks, and only the console boundary is captured for assertions.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { version } from "./version";

const commandDir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(commandDir, "../../package.json"), "utf-8"),
) as { name: string; version: string };

const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// Direct assignment rather than vi.spyOn: vitest's own console interception
// leaves spy call records empty, so the boundary is swapped and restored here.
function renderVersionOutput(): string[] {
  const calls: string[] = [];
  const original = console.log;
  console.log = ((...args: unknown[]) => {
    const first = args.at(0);
    calls.push(first === undefined ? "" : String(first).replace(ANSI_SGR, ""));
  }) as typeof console.log;
  try {
    version();
  } finally {
    console.log = original;
  }
  return calls;
}

describe("version", () => {
  it("renders an eight-line block padded by blank lines around the banner", () => {
    const lines = renderVersionOutput();
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("elizaOS CLI");
    expect(lines[2]).toBe("");
    expect(lines[7]).toBe("");
  });

  it("reports the installed manifest version on an indented Version line before the Package line", () => {
    const lines = renderVersionOutput();
    const versionLine = lines.indexOf(`  Version:  ${manifest.version}`);
    const packageLine = lines.findIndex((line) =>
      line.startsWith("  Package:"),
    );
    expect(versionLine).toBeGreaterThanOrEqual(0);
    expect(versionLine).toBeLessThan(packageLine);
  });

  it("reports the installed manifest package name on an indented Package line", () => {
    const lines = renderVersionOutput();
    expect(lines).toContain(`  Package:  ${manifest.name}`);
  });

  it("keeps the upgrade tagline on its own indented line", () => {
    const lines = renderVersionOutput();
    expect(lines[6]).toBe("  Create and upgrade elizaOS projects and plugins.");
  });
});
