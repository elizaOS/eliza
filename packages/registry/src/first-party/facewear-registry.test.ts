/**
 * Verifies the plugin-owned facewear entry validates against the first-party
 * schema and is discoverable by both id and npm package name through the loaded
 * registry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRegistryFromRawEntries } from "./loader";
import { registryEntrySchema } from "./schema";

// The facewear entry is plugin-owned: it lives next to its plugin and is
// aggregated into generated.json at build time (see generate.ts).
const FACEWEAR_ENTRY_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "plugins",
  "plugin-facewear",
  "registry-entry.json",
);

describe("facewear registry entry", () => {
  it("is valid and discoverable by id and npm package name", () => {
    const data = JSON.parse(readFileSync(FACEWEAR_ENTRY_PATH, "utf8"));
    const parsed = registryEntrySchema.parse(data);
    const registry = loadRegistryFromRawEntries([
      { file: FACEWEAR_ENTRY_PATH, data },
    ]);

    if (parsed.kind !== "plugin") {
      throw new Error("Expected facewear registry entry to be a plugin");
    }

    expect(parsed.kind).toBe("plugin");
    if (parsed.kind !== "plugin") {
      throw new Error("Expected facewear registry entry to be a plugin");
    }
    expect(parsed.subtype).toBe("media");
    expect(parsed.npmName).toBe("@elizaos/plugin-facewear");
    expect(parsed.config).toHaveProperty("FACEWEAR_SMARTGLASSES_TRANSPORT");
    expect(parsed.config).toHaveProperty("FACEWEAR_INIT_MODE");
    expect(parsed.tags).toEqual(
      expect.arrayContaining([
        "facewear",
        "xr",
        "smartglasses",
        "even-realities",
        "bluetooth",
        "wifi",
      ]),
    );
    expect(parsed.render.actions).toContain("launch");
    expect(data.launch.target).toBe("facewear");
    expect(data.launch.capabilities).toEqual(
      expect.arrayContaining([
        "whole-headset-pairing",
        "side-tap-microphone-control",
        "wifi-provisioning",
      ]),
    );
    expect(registry.byId.get("facewear")?.name).toBe("Facewear");
    expect(registry.byNpmName.get("@elizaos/plugin-facewear")?.id).toBe(
      "facewear",
    );
  });
});
