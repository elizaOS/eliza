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

it("never claims a native client opened a site it did not confirm", async () => {
  const service = new BrowserService();
  const sent: Array<string | undefined> = [];
  service.setNativeClientTransport({
    readPage: async () => ({}),
    navigate: async (_clientId, url) => {
      sent.push(url);
    },
  });
  const runtime = { getService: () => service } as unknown as IAgentRuntime;
  // A spoken request from the phone's native app, as the voice bridge sends it.
  const message = {
    content: {
      text: "open youtube.com",
      channelType: "VOICE_DM",
      metadata: { uiBrowserSurface: "native", viewClientId: "phone-1" },
    },
  };
  const result = await browserAction.handler(
    runtime,
    message as Memory,
    undefined,
    { parameters: { action: "open", url: "https://youtube.com" } },
  );
  expect(sent).toEqual(["https://youtube.com/"]);
  expect(result).toMatchObject({
    success: true,
    userFacingText:
      "I sent youtube.com to your browser, but it hasn't confirmed that it opened.",
    verifiedUserFacing: true,
    turnComplete: true,
  });
  expect(result).not.toHaveProperty("modelReplyRequired");
});
