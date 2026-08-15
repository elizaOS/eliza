/**
 * Guards e2e harness scripts against hardcoded listen ports. Fixed port
 * constants die EADDRINUSE when CI fan-out places concurrent harness jobs on
 * one shared runner host (#18359); harnesses must either allocate
 * kernel-assigned ports (packages/ui/scripts/e2e-ports.mjs) or derive a
 * per-runner deterministic port (packages/homepage/scripts/e2e-port.mjs).
 * Runs against the real repository via git-tracked file discovery.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

// A harness script: a run-*e2e*.mjs runner or any .mjs living in an __e2e__
// directory. Resolver/allocator modules are not harnesses and are exempt by
// construction (they do not match these shapes).
const HARNESS_PATH = /(^|\/)(run-[^/]*e2e[^/]*\.mjs|[^/]*__e2e__\/[^/]+\.mjs)$/;

// A numeric port assigned to a *_PORT-style binding or passed straight to
// listen(). Four to five digits keeps well-known tiny literals (0, retries,
// timeouts in ms have more digits or different names) out of scope.
const HARDCODED_PORT =
  /\b[A-Za-z_]*PORT\b\s*[:=]\s*(\d{4,5})\b|\.listen\(\s*(\d{4,5})\b/;

function trackedHarnessFiles(): string[] {
  const stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((file) => file && HARNESS_PATH.test(file));
}

describe("e2e harness port hygiene", () => {
  it("finds harness scripts to scan (guard is not vacuous)", () => {
    const files = trackedHarnessFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(
      "packages/ui/src/cloud/organization/__e2e__/run-credentials-e2e.mjs",
    );
  });

  it("no e2e harness hardcodes a listen port", () => {
    const offenders: string[] = [];
    for (const file of trackedHarnessFiles()) {
      const lines = readFileSync(path.join(REPO_ROOT, file), "utf8").split(
        "\n",
      );
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // Comment lines (usage examples in headers) are not live bindings.
        if (
          trimmed.startsWith("*") ||
          trimmed.startsWith("//") ||
          trimmed.startsWith("/*")
        ) {
          return;
        }
        if (HARDCODED_PORT.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "Hardcoded e2e listen ports collide under CI fan-out (#18359). " +
        "Use allocateFreePorts (packages/ui/scripts/e2e-ports.mjs) or a " +
        "per-runner resolver (packages/homepage/scripts/e2e-port.mjs).",
    ).toEqual([]);
  });

  it("rejects the pattern this guard exists for", () => {
    expect(HARDCODED_PORT.test("const PAGE_PORT = 36414;")).toBe(true);
    expect(HARDCODED_PORT.test("server.listen(36414, host);")).toBe(true);
    expect(
      HARDCODED_PORT.test(
        "const [API_PORT, PAGE_PORT] = await allocateFreePorts(2);",
      ),
    ).toBe(false);
    expect(HARDCODED_PORT.test('server.listen(0, "127.0.0.1");')).toBe(false);
  });
});
