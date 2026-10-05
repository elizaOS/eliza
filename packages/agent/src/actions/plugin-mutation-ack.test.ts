import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginAction } from "./plugin.ts";

afterEach(() => vi.unstubAllGlobals());

async function run(
  action: string,
  pluginId: string,
  body: unknown,
  malformed = false,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(malformed ? "<html>proxy</html>" : JSON.stringify(body), {
          status: 200,
        }),
    ),
  );
  return pluginAction.handler(
    {} as IAgentRuntime,
    { roomId: "room" } as unknown as Memory,
    undefined,
    { parameters: { action, pluginId, enabled: false } },
    undefined,
  );
}

describe("PLUGIN mutation acknowledgement", () => {
  it.each(["toggle", "disconnect"])(
    "rejects unacknowledged %s mutations",
    async (action) => {
      for (const body of [
        {},
        { error: "rejected" },
        { ok: "true" },
        [],
        null,
      ]) {
        expect((await run(action, "discord", body)).success).toBe(false);
      }
      expect((await run(action, "discord", null, true)).success).toBe(false);
    },
  );
  it.each(["toggle", "disconnect"])(
    "accepts explicit %s acknowledgements and rejects contradictions",
    async (action) => {
      expect((await run(action, "discord", { ok: true })).success).toBe(true);
      expect((await run(action, "discord", { success: true })).success).toBe(
        true,
      );
      expect(
        (await run(action, "discord", { ok: true, success: false })).success,
      ).toBe(false);
    },
  );
  it("requires a completed Telegram cancellation state", async () => {
    expect((await run("disconnect", "telegram", {})).success).toBe(false);
    expect(
      (
        await run("disconnect", "telegram", {
          connector: "telegram-account",
          state: "connected",
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await run("disconnect", "telegram", {
          connector: "telegram-account",
          state: "idle",
        })
      ).success,
    ).toBe(true);
    expect(
      (
        await run("disconnect", "telegram", {
          connector: "telegram-account",
          state: "idle",
          ok: false,
        })
      ).success,
    ).toBe(false);
  });
  it("requires a dedicated disconnect acknowledgement", async () => {
    for (const id of ["whatsapp", "discord-local"]) {
      expect((await run("disconnect", id, {})).success).toBe(false);
      expect((await run("disconnect", id, { ok: true })).success).toBe(true);
    }
  });
});
