import type { Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveOriginatingRequestText } from "../actions/common.js";

const AGENT = "00000000-0000-0000-0000-00000000aaaa";
const USER = "00000000-0000-0000-0000-00000000bbbb";
const runtime = { agentId: AGENT } as never;

function stateWith(previousUserText: string) {
  return {
    data: {
      providers: {
        RECENT_MESSAGES: {
          data: {
            recentMessages: [
              {
                entityId: USER,
                content: { text: previousUserText },
              },
            ],
          },
        },
      },
    },
  } as never;
}

describe("resolveOriginatingRequestText", () => {
  it("a genuine user turn routes on its own words only", async () => {
    const message = {
      entityId: USER,
      roomId: "room",
      content: { text: "write me a python script that prints a random prime" },
    } as unknown as Memory;
    expect(
      await resolveOriginatingRequestText(
        runtime,
        message,
        stateWith("how many .ts files are in milady-fork?"),
      ),
    ).toBe("write me a python script that prints a random prime");
  });

  it("a sub-agent relay falls back to the user's request in the window", async () => {
    const message = {
      entityId: USER,
      roomId: "room",
      content: {
        text: "[sub-agent: build] failed: state lost",
        source: "acpx:sub-agent-router",
        metadata: { subAgent: true },
      },
    } as unknown as Memory;
    expect(
      await resolveOriginatingRequestText(
        runtime,
        message,
        stateWith("make me a dice roller web page"),
      ),
    ).toBe(
      "make me a dice roller web page\n[sub-agent: build] failed: state lost",
    );
  });
});
