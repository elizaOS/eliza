/**
 * Temporary-key cleanup for the Hetzner readiness probe, exercising the real
 * repository cleanup helper without making SSH or cloud API calls.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRecursive } from "./hetzner-e2e-wait-ready";

describe("Hetzner E2E readiness cleanup", () => {
  test("removes its temporary key directory through the repository helper", () => {
    const directory = mkdtempSync(join(tmpdir(), "hetzner-wait-ready-test-"));
    writeFileSync(join(directory, "id_ed25519"), "test-only-key\n", "utf8");

    rmRecursive(directory);

    expect(existsSync(directory)).toBe(false);
  });
});
