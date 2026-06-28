/**
 * Smoke test for the chainsaw test runner configuration that drives the
 * cluster integration suites under `cloud/tests/0*`. A broken config here
 * silently turns CI green by skipping every test, so we verify the basic
 * shape and the timeouts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const CONFIG_PATH = join(
  import.meta.dir,
  "..",
  "cloud",
  "tests",
  ".chainsaw.yaml",
);

describe(".chainsaw.yaml (cluster integration test runner)", () => {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const doc = parseYaml(raw) as {
    apiVersion: string;
    kind: string;
    metadata: { name: string };
    spec: {
      timeouts: Record<string, string>;
      cleanup: { skipDelete: boolean };
      execution: { parallel: number; failFast: boolean };
    };
  };

  test("declares the chainsaw Configuration kind", () => {
    expect(doc.apiVersion).toMatch(/^chainsaw\./);
    expect(doc.kind).toBe("Configuration");
    expect(doc.metadata.name).toBe("eliza-operator-tests");
  });

  test("sets explicit timeouts for every chainsaw lifecycle phase", () => {
    const timeouts = doc.spec.timeouts;
    for (const key of ["apply", "assert", "cleanup", "delete", "exec"]) {
      expect(typeof timeouts[key]).toBe("string");
      expect(timeouts[key]).toMatch(/^\d+(s|m|h)$/);
    }
  });

  test("uses bounded parallelism so kind clusters do not get overwhelmed", () => {
    expect(doc.spec.execution.parallel).toBeGreaterThan(0);
    expect(doc.spec.execution.parallel).toBeLessThanOrEqual(10);
  });

  test("does not stop early or skip cleanup", () => {
    expect(doc.spec.execution.failFast).toBe(false);
    expect(doc.spec.cleanup.skipDelete).toBe(false);
  });
});
