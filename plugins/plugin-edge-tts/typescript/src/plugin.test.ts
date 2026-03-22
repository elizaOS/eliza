import { describe, expect, it } from "bun:test";
import edgeTTSPlugin from "./index";

describe("plugin-edge-tts", () => {
  it("exports a plugin with name and models", () => {
    expect(edgeTTSPlugin).toBeDefined();
    expect(edgeTTSPlugin.name).toBe("edge-tts");
    expect(edgeTTSPlugin.models).toBeDefined();
  });
});
