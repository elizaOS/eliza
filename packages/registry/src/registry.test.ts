/**
 * Tests for the third-party registry tooling: `validateRegistryEntry` accepts a
 * well-formed entry and rejects the reserved @elizaos scope, non-GitHub repos,
 * unknown kinds, and unknown fields; `generateRegistry` produces the wire
 * format. Runs against the real entries/third-party sources on disk.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateRegistry, toGeneratedEntry } from "./generate.ts";
import { loadThirdPartyEntries } from "./loader.ts";
import { validateRegistryEntry } from "./schema.ts";
import type { RegistryEntry } from "./types.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const VALID: RegistryEntry = {
  package: "elizaos-plugin-echo",
  repository: "github:elizaOS/eliza",
  kind: "plugin",
  description: "Echoes a message.",
  directory: "packages/examples/plugin-echo",
  tags: ["example"],
};

describe("validateRegistryEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(validateRegistryEntry(VALID)).toEqual([]);
  });

  it("rejects the reserved @elizaos scope", () => {
    const errors = validateRegistryEntry({
      ...VALID,
      package: "@elizaos/plugin-echo",
    });
    expect(errors).toContain(
      "package must not use the reserved @elizaos/* scope",
    );
  });

  it("rejects a non-github repository", () => {
    const errors = validateRegistryEntry({
      ...VALID,
      repository: "gitlab:owner/repo",
    });
    expect(errors).toContain(
      'repository must be of the form "github:owner/repo"',
    );
  });

  it("rejects an unknown kind", () => {
    const errors = validateRegistryEntry({ ...VALID, kind: "widget" });
    expect(errors.some((e) => e.startsWith("kind must be one of"))).toBe(true);
  });

  it("rejects unknown fields", () => {
    const errors = validateRegistryEntry({ ...VALID, bogus: true });
    expect(errors).toContain("unknown field: bogus");
  });
});

describe("toGeneratedEntry", () => {
  it("maps a source entry to the wire format", () => {
    const wire = toGeneratedEntry(VALID);
    expect(wire.git.repo).toBe("elizaOS/eliza");
    expect(wire.npm.repo).toBe("elizaos-plugin-echo");
    expect(wire.thirdParty).toBe(true);
    expect(wire.firstParty).toBe(false);
    expect(wire.supports).toEqual({ v0: false, v1: false, v2: true });
    expect(wire.directory).toBe("packages/examples/plugin-echo");
  });
});

describe("on-disk entries", () => {
  it("all entries are valid and include the echo example", () => {
    const entries = loadThirdPartyEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.package === "elizaos-plugin-echo")).toBe(true);
    const { registry } = generateRegistry(entries);
    expect(registry["elizaos-plugin-echo"]).toBeDefined();
  });

  it("keeps generated-registry.json in sync with source entries", () => {
    const generatedPath = path.join(packageRoot, "generated-registry.json");
    const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
    expect(generated).toEqual(generateRegistry(loadThirdPartyEntries()));
  });
});
