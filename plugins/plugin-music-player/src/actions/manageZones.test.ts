import { describe, expect, it } from "vitest";
import { ZoneManager } from "../router";
import { manageZones } from "./manageZones";

function createCallbackMessages() {
  const messages: Array<{ text?: string; source?: string }> = [];
  const callback = async (payload: { text?: string; source?: string }) => {
    messages.push(payload);
    return [];
  };
  return { messages, callback };
}

describe("manageZones action", () => {
  it("creates, lists, shows, mutates, and deletes zones through the real zone manager", async () => {
    const zoneManager = new ZoneManager();
    const runtime = {
      getService: async () => ({
        getZoneManager: () => zoneManager,
      }),
    };
    const { messages, callback } = createCallbackMessages();

    await manageZones.handler(
      runtime as never,
      {
        content: {
          text: "create zone lounge with bot-a, bot-b",
          source: "discord",
        },
      } as never,
      undefined,
      undefined,
      callback as never,
    );
    expect(messages.at(-1)?.text).toContain(
      'Created zone "lounge" with 2 target(s)',
    );
    expect(zoneManager.get("lounge")?.targetIds).toEqual(["bot-a", "bot-b"]);

    await manageZones.handler(
      runtime as never,
      {
        content: { text: "add bot-c to zone lounge", source: "discord" },
      } as never,
      undefined,
      undefined,
      callback as never,
    );
    expect(zoneManager.get("lounge")?.targetIds).toEqual([
      "bot-a",
      "bot-b",
      "bot-c",
    ]);

    await manageZones.handler(
      runtime as never,
      { content: { text: "show zone lounge", source: "discord" } } as never,
      undefined,
      undefined,
      callback as never,
    );
    expect(messages.at(-1)?.text).toContain("Targets: 3");
    expect(messages.at(-1)?.text).toContain("bot-a, bot-b, bot-c");

    await manageZones.handler(
      runtime as never,
      {
        content: { text: "remove bot-b from zone lounge", source: "discord" },
      } as never,
      undefined,
      undefined,
      callback as never,
    );
    expect(zoneManager.get("lounge")?.targetIds).toEqual(["bot-a", "bot-c"]);

    await manageZones.handler(
      runtime as never,
      { content: { text: "list zones", source: "discord" } } as never,
      undefined,
      undefined,
      callback as never,
    );
    expect(messages.at(-1)?.text).toContain("lounge (2 targets)");

    await manageZones.handler(
      runtime as never,
      { content: { text: "delete zone lounge", source: "discord" } } as never,
      undefined,
      undefined,
      callback as never,
    );
    expect(zoneManager.exists("lounge")).toBe(false);
    expect(messages.at(-1)?.text).toContain('Deleted zone "lounge"');
  });
});
