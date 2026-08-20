/**
 * Verifies the real device-e2e host installs app-core session authorization
 * before it starts the agent HTTP server.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("serve-real-local-agent auth bridge", () => {
  it("installs paired-device session authorization before startApiServer", async () => {
    const source = await readFile(
      new URL("./serve-real-local-agent.ts", import.meta.url),
      "utf8",
    );
    const installIndex = source.indexOf("installAgentHostBridge();");
    const serverIndex = source.indexOf("const server = await startApiServer(");

    expect(installIndex).toBeGreaterThan(-1);
    expect(serverIndex).toBeGreaterThan(installIndex);
  });
});
