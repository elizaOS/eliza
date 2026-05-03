import { describe, expect, test } from "vitest";
import minecraftPlugin from "../src/index.js";

describe("plugin-minecraft smoke", () => {
  test("exports plugin metadata", () => {
    expect(minecraftPlugin.name).toBe("plugin-minecraft");
    expect(typeof minecraftPlugin.description).toBe("string");
  });
});
