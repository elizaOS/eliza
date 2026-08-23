import { describe, expect, it } from "vitest";
import {
  Agent,
  Desktop,
  startDeviceBridgeClient,
} from "./native-plugin-stubs.ts";

describe("native-plugin-stubs", () => {
  it("Agent.getStatus reports unavailable", async () => {
    expect(await Agent.getStatus()).toEqual({ status: "unavailable" });
  });

  it("Desktop reports a N/A runtime and registers no-op handles", async () => {
    expect(await Desktop.getVersion()).toEqual({ runtime: "N/A" });
    await Desktop.registerShortcut({ id: "x", accelerator: "Cmd+K" });
    const handle = await Desktop.addListener("shortcutPressed", () => {});
    expect(handle.remove).toBeDefined();
    await handle.remove();
    await Desktop.setTrayMenu({ menu: [] });
  });

  it("startDeviceBridgeClient returns a stoppable client", () => {
    const client = startDeviceBridgeClient({ agentUrl: "http://x" });
    expect(client.stop).toBeDefined();
    client.stop();
  });
});
