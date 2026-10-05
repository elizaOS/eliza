import { expect, test } from "bun:test";
import { elevenLabsPlugin } from "./elizaos-plugin-elevenlabs";

test("Worker speech plugin initialization fails explicitly instead of registering no capability", async () => {
  await expect(elevenLabsPlugin.init()).rejects.toThrow("agent-server sidecar");
});
