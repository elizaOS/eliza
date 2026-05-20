import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRegistryFromRawEntries } from "./loader";
import { registryEntrySchema } from "./schema";

const FACEWEAR_ENTRY_PATH = join(
  import.meta.dirname,
  "entries",
  "plugins",
  "hearwear.json",
);

describe("hearwear registry entry", () => {
  it("is valid and discoverable by id and npm package name", () => {
    const data = JSON.parse(readFileSync(FACEWEAR_ENTRY_PATH, "utf8"));
    const parsed = registryEntrySchema.parse(data);
    const registry = loadRegistryFromRawEntries([
      { file: FACEWEAR_ENTRY_PATH, data },
    ]);

    expect(parsed.kind).toBe("plugin");
    expect(parsed.subtype).toBe("media");
    expect(parsed.npmName).toBe("@elizaos/plugin-hearwear");
    expect(parsed.config).toHaveProperty("FACEWEAR_SMARTGLASSES_TRANSPORT");
    expect(parsed.config).toHaveProperty("FACEWEAR_INIT_MODE");
    expect(parsed.tags).toEqual(
      expect.arrayContaining([
        "hearwear",
        "xr",
        "smartglasses",
        "even-realities",
        "bluetooth",
        "wifi",
      ]),
    );
    expect(parsed.render.actions).toContain("launch");
    expect(data.launch.target).toBe("hearwear");
    expect(data.launch.capabilities).toEqual(
      expect.arrayContaining([
        "whole-headset-pairing",
        "side-tap-microphone-control",
        "wifi-provisioning",
      ]),
    );
    expect(registry.byId.get("hearwear")?.name).toBe("Hearwear");
    expect(registry.byNpmName.get("@elizaos/plugin-hearwear")?.id).toBe(
      "hearwear",
    );
  });
});
