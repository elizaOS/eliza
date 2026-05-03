import { describe, expect, it } from "vitest";
import { MusicService } from "../service";
import { manageRouting } from "./manageRouting";

function createCallbackMessages() {
  const messages: Array<{ text?: string; source?: string }> = [];
  const callback = async (payload: { text?: string; source?: string }) => {
    messages.push(payload);
    return [];
  };
  return { messages, callback };
}

describe("manageRouting action", () => {
  it("updates routing mode and manages real broadcast routes", async () => {
    const musicService = new MusicService();
    musicService.registerRoutingTargets([
      {
        id: "bot-a",
        type: "test",
        feed: async () => undefined,
        stop: async () => undefined,
      },
      {
        id: "bot-b",
        type: "test",
        feed: async () => undefined,
        stop: async () => undefined,
      },
    ]);
    musicService.getZoneManager().create("lounge", ["bot-a", "bot-b"]);

    const runtime = {
      getService: async () => musicService,
    };
    const { messages, callback } = createCallbackMessages();

    await manageRouting.handler(
      runtime as never,
      { content: { text: "set mode independent", source: "discord" } } as never,
      undefined,
      undefined,
      callback as never,
    );
    expect(musicService.getRoutingMode()).toBe("independent");
    expect(messages.at(-1)?.text).toContain("Routing mode set to: independent");

    await manageRouting.handler(
      runtime as never,
      {
        content: { text: "route main-guild to lounge", source: "discord" },
      } as never,
      undefined,
      undefined,
      callback as never,
    );
    expect(musicService.getAudioRouter().isRouted("main-guild")).toBe(true);
    expect(messages.at(-1)?.text).toContain(
      "Broadcasting main-guild to 2 target(s) in independent mode",
    );

    await manageRouting.handler(
      runtime as never,
      { content: { text: "show routing status", source: "discord" } } as never,
      undefined,
      undefined,
      callback as never,
    );
    expect(messages.at(-1)?.text).toContain("Registered Targets: 2");
    expect(messages.at(-1)?.text).toContain(
      "main-guild → 2 targets (independent)",
    );

    await manageRouting.handler(
      runtime as never,
      {
        content: { text: "stop routing main-guild", source: "discord" },
      } as never,
      undefined,
      undefined,
      callback as never,
    );
    expect(musicService.getAudioRouter().isRouted("main-guild")).toBe(false);
    expect(messages.at(-1)?.text).toContain("Stopped routing for main-guild");

    await musicService.stop();
  });
});
