import type { IAgentRuntime, Memory } from "@elizaos/core";
import { expect, it } from "vitest";
import { BrowserService } from "../browser-service.js";
import { NativeSocketBrowserTarget } from "../native-socket-target.js";
import { browserAction } from "./browser.js";

it("offers BROWSER only when a target can act, without a network probe", async () => {
  const service = new BrowserService();
  service.registerTarget(new NativeSocketBrowserTarget(() => {}));
  const runtime = { getService: () => service } as unknown as IAgentRuntime;
  const message = { content: { text: "open github.com/elizaOS/eliza" } };
  expect(await browserAction.validate(runtime, message as Memory)).toBe(false);

  service.registerTarget({
    id: "device:phone:owner-profile",
    name: "Phone Chromium",
    description: "A paired device that only the cloud relay can reach.",
    available: () =>
      Promise.reject(new Error("validate must not probe the network")),
    execute: () => Promise.reject(new Error("not dispatched")),
  });
  expect(await browserAction.validate(runtime, message as Memory)).toBe(true);
});
