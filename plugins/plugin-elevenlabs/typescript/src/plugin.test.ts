import { describe, expect, it } from "bun:test";
import elevenLabsPlugin from "./index";

describe("plugin-elevenlabs", () => {
  it("exports a plugin with name and models", () => {
    expect(elevenLabsPlugin).toBeDefined();
    expect(elevenLabsPlugin.name).toBe("elevenLabs");
    expect(elevenLabsPlugin.models).toBeDefined();
  });
});
