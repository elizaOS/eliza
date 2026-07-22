/**
 * Protects the Feed environment audit's source-only CI path. The scanner has
 * no workspace dependencies, so this lane installs only Bun and never pays for
 * repository postinstall, native tooling, caches, or artifact hydration.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github/workflows/feed-env-audit.yml"),
  "utf8",
);
const SCANNER = readFileSync(
  join(REPO_ROOT, "packages/feed/scripts/env-audit.ts"),
  "utf8",
);

describe("Feed environment-audit workflow", () => {
  test("uses direct pinned Bun setup without workspace hydration", () => {
    expect(WORKFLOW).toContain(
      "uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    );
    expect(WORKFLOW).toContain('bun-version: "1.3.14"');
    expect(WORKFLOW).toContain(
      "run: bun run --cwd packages/feed env:audit:check",
    );
    expect(WORKFLOW).not.toContain("setup-bun-workspace");
    expect(WORKFLOW).not.toContain("bun install");
    expect(WORKFLOW).not.toContain("sync-artifacts");
  });

  test("scanner imports only runtime built-ins", () => {
    const imports = Array.from(
      SCANNER.matchAll(/\bfrom\s+["']([^"']+)["']/g),
      (match) => match[1],
    );

    expect(imports.length).toBeGreaterThan(0);
    expect(
      imports.filter((specifier) => !specifier.startsWith("node:")),
    ).toEqual([]);
  });
});
