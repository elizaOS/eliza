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

const VALID_APP: RegistryEntry = {
  package: "@example/app-school",
  repository: "github:example/app-school",
  kind: "app",
  description: "A launchable school app.",
  homepage: "https://school.example",
  version: "1.2.3",
  app: {
    displayName: "School",
    category: "education",
    launchType: "connect",
    launchUrl: null,
    icon: "./images/logo.jpg",
    heroImage: "./images/banner.jpg",
    capabilities: ["education"],
    runtimePlugin: "@example/app-school",
    viewer: {
      url: "/school/viewer",
      postMessageAuth: false,
      sandbox: "allow-scripts allow-same-origin",
    },
    session: {
      mode: "external",
      features: ["commands", "telemetry"],
    },
    visibleInAppStore: true,
    catalogSection: "other",
  },
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

  it("accepts complete app metadata", () => {
    expect(validateRegistryEntry(VALID_APP)).toEqual([]);
  });

  it("requires app metadata for app entries", () => {
    expect(validateRegistryEntry({ ...VALID_APP, app: undefined })).toContain(
      "app must be an object for app entries",
    );
  });

  it("rejects app metadata on non-app entries", () => {
    expect(validateRegistryEntry({ ...VALID, app: VALID_APP.app })).toContain(
      "app metadata is only allowed when kind is app",
    );
  });

  it("validates nested app metadata", () => {
    const errors = validateRegistryEntry({
      ...VALID_APP,
      app: {
        ...VALID_APP.app,
        minPlayers: 2,
        maxPlayers: 1,
        viewer: { url: "", sandbox: 42 },
        session: { mode: "invalid", features: ["commands", "invalid"] },
      },
    });
    expect(errors).toContain("app.minPlayers must not exceed app.maxPlayers");
    expect(errors).toContain("app.viewer.url must be a non-empty string");
    expect(errors).toContain(
      "app.viewer.sandbox must be a string when present",
    );
    expect(errors.some((error) => error.startsWith("app.session.mode"))).toBe(
      true,
    );
    expect(
      errors.some((error) => error.startsWith("app.session.features")),
    ).toBe(true);
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

  it("preserves app launch metadata in the wire format", () => {
    const wire = toGeneratedEntry(VALID_APP);
    expect(wire.kind).toBe("app");
    expect(wire.registryKind).toBe("app");
    expect(wire.app).toEqual({
      ...VALID_APP.app,
      minPlayers: null,
      maxPlayers: null,
    });
    expect(wire.app?.viewer?.url).toBe("/school/viewer");
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
