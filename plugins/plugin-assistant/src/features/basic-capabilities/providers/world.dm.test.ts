/**
 * General-context providers add no prompt text when they have nothing to
 * report for a DM. Live tj-786ca91739ceaa: every planner call of the turn
 * carried "No upcoming follow-ups scheduled." and the census of all 84 DM
 * rooms in the world.
 */

import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it } from "vitest";
import { followUpsProvider } from "../../advanced-capabilities/providers/followUps.ts";
import { worldProvider } from "./world.ts";

const roomId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const worldId = "00000000-0000-0000-0000-0000000000cc" as UUID;
const message = {
  id: "00000000-0000-0000-0000-0000000000aa",
  roomId,
  entityId: "00000000-0000-0000-0000-0000000000e1",
  content: { text: "move it to 4pm", source: "client_chat" },
} as unknown as Memory;
const state = { values: {}, data: {}, text: "" } as State;

function worldRuntime(type: ChannelType): IAgentRuntime {
  return createMockRuntime({
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getRoom: (async () => ({
      id: roomId,
      name: "Alpha Phone",
      type,
      worldId,
    })) as unknown as IAgentRuntime["getRoom"],
    getWorld: (async () => ({
      id: worldId,
      name: "Home",
    })) as unknown as IAgentRuntime["getWorld"],
    getRooms: (async () => [
      { id: roomId, name: "Alpha Phone", type },
      {
        id: "00000000-0000-0000-0000-0000000000dd",
        name: "Other",
        type: ChannelType.DM,
      },
    ]) as unknown as IAgentRuntime["getRooms"],
    getParticipantsForRoom: (async () => [
      "00000000-0000-0000-0000-0000000000e1",
      "00000000-0000-0000-0000-000000000001",
    ]) as unknown as IAgentRuntime["getParticipantsForRoom"],
  });
}

describe("WORLD provider", () => {
  it("describes a DM without the census of the world's other rooms", async () => {
    const result = await worldProvider.get(
      worldRuntime(ChannelType.DM),
      message,
      state,
    );
    expect(result.text).toBe(
      "World: Home; current channel: Alpha Phone (DM), participants=2",
    );
    expect(result.data?.world).toMatchObject({
      channelStats: { total: 2, dm: 2 },
    });
  });

  it("keeps the census for a group channel", async () => {
    const result = await worldProvider.get(
      worldRuntime(ChannelType.GROUP),
      message,
      state,
    );
    expect(result.text).toContain(
      "channels: total=2, text=1, voice=0, DM=1, feed=0, thread=0, other=0",
    );
  });
});

describe("FOLLOW_UPS provider", () => {
  it("adds no text when nothing is scheduled", async () => {
    const runtime = createMockRuntime({
      getService: (() => ({
        getUpcomingFollowUps: async () => [],
      })) as unknown as IAgentRuntime["getService"],
    });
    const result = await followUpsProvider.get(runtime, message, state);
    expect(result.text).toBe("");
    expect(result.values).toEqual({ followUpCount: 0 });
  });
});
