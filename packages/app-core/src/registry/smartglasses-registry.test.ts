import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistryFromRawEntries } from "./loader";
import { registryEntrySchema } from "./schema";

const SMARTGLASSES_ENTRY_PATH = join(
  import.meta.dirname,
  "entries",
  "plugins",
  "smartglasses.json",
);

describe("smartglasses registry entry", () => {
  it("is valid and discoverable by id and npm package name", () => {
    const data = JSON.parse(readFileSync(SMARTGLASSES_ENTRY_PATH, "utf8"));
    const parsed = registryEntrySchema.parse(data);
    const registry = loadRegistryFromRawEntries([
      { file: SMARTGLASSES_ENTRY_PATH, data },
    ]);

    expect(parsed.kind).toBe("plugin");
    expect(parsed.subtype).toBe("media");
    expect(parsed.npmName).toBe("@elizaos/plugin-smartglasses");
    expect(parsed.config).toHaveProperty("SMARTGLASSES_TRANSPORT");
    expect(parsed.config).toHaveProperty("SMARTGLASSES_INIT_MODE");
    expect(parsed.tags).toEqual(
      expect.arrayContaining([
        "smartglasses",
        "even-realities",
        "bluetooth",
        "wifi",
      ]),
    );
    expect(parsed.render.actions).toContain("launch");
    expect(parsed.launch?.target).toBe("smartglasses");
    expect(parsed.launch?.capabilities).toContain("wifi-provisioning");
    expect(registry.byId.get("smartglasses")?.name).toBe("Smartglasses");
    expect(registry.byNpmName.get("@elizaos/plugin-smartglasses")?.id).toBe(
      "smartglasses",
    );
  });
});
