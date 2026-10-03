/**
 * Validates the shipped Crypto Queen character against the real core character
 * schema and checks that every plugin it loads is a workspace package, so the
 * file stays loadable as the schema and plugin set evolve.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCharacter } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const raw: unknown = JSON.parse(
  readFileSync(path.join(here, "../../characters/crypto-queen.json"), "utf8"),
);

function workspacePackageNames(): Set<string> {
  const names = new Set<string>();
  for (const dir of [
    "plugins/plugin-sql",
    "plugins/plugin-openai",
    "plugins/plugin-wallet",
  ]) {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"),
    ) as { name: string };
    names.add(manifest.name);
  }
  return names;
}

describe("crypto-queen character", () => {
  it("passes the strict core character schema", () => {
    const result = validateCharacter(raw);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.data?.name).toBe("Crypto Queen");
  });

  it("loads only workspace plugins", () => {
    const result = validateCharacter(raw);
    const available = workspacePackageNames();
    for (const plugin of result.data?.plugins ?? []) {
      expect(available.has(plugin), plugin).toBe(true);
    }
    expect(result.data?.plugins).toContain("@elizaos/plugin-wallet");
  });
});
