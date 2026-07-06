/**
 * Drift guard: every env var a guarded live suite requires, and every secret
 * the post-merge lane warns about, must be owned by a connection in the
 * console catalog — otherwise the console renders a gate it cannot explain
 * or configure. Runs with `bun test`; pure data, no network.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GUARDED_REAL_LIVE_SUITES } from "../../lib/real-live-suites.mjs";
import {
  CONNECTIONS,
  OPT_IN_GATES,
  varOwnership,
} from "../lib/connections.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("connection catalog coverage", () => {
  const owners = varOwnership();

  test("every guarded-suite env var maps to a connection", () => {
    const unmapped: string[] = [];
    for (const entry of GUARDED_REAL_LIVE_SUITES) {
      const vars = [...(entry.requires ?? []), ...(entry.anyOf ?? []).flat()];
      for (const key of vars) {
        if (!owners.has(key)) unmapped.push(`${key} (${entry.file})`);
      }
    }
    expect(unmapped).toEqual([]);
  });

  test("every guarded-suite opt-in gate is a console toggle", () => {
    const toggles = new Set(OPT_IN_GATES.map((gate) => gate.key));
    const missing = GUARDED_REAL_LIVE_SUITES.filter(
      (entry) => entry.optIn && !toggles.has(entry.optIn),
    ).map((entry) => `${entry.optIn} (${entry.file})`);
    expect(missing).toEqual([]);
  });

  test("every post-merge secret maps to a connection", () => {
    const secretsFile = path.resolve(here, "../../post-merge-secrets.txt");
    const secrets = fs
      .readFileSync(secretsFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const unmapped = secrets.filter((key) => !owners.has(key));
    expect(unmapped).toEqual([]);
  });

  test("connection ids are unique and fields are non-empty", () => {
    const ids = CONNECTIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const connection of CONNECTIONS) {
      expect(connection.fields.length).toBeGreaterThan(0);
      expect(connection.fields.some((f) => f.required)).toBe(true);
    }
  });
});
