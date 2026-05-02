import { ChannelType, createMessageMemory, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import executeGameAction from "../actions/executeGameAction";

class FakeRobloxService {
  calls: Array<{
    agentId: UUID;
    actionName: string;
    parameters: Record<string, string | number | boolean | null>;
    targetPlayerIds?: number[];
  }> = [];

  async executeAction(
    agentId: UUID,
    actionName: string,
    parameters: Record<string, string | number | boolean | null>,
    targetPlayerIds?: number[]
  ): Promise<void> {
    this.calls.push({ agentId, actionName, parameters, targetPlayerIds });
  }
}

describe("EXECUTE_ROBLOX_ACTION parsing", () => {
  it("parses move_npc waypoint from user message", async () => {
    const service = new FakeRobloxService();
    const runtime = {
      agentId: uuidv4() as UUID,
      getService: <T>(_name: string) => service as never as T,
    };

    const msg = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: uuidv4() as UUID,
      roomId: uuidv4() as UUID,
      content: { text: "move the npc to spawn", source: "test", channelType: ChannelType.DM },
    });

    await executeGameAction.handler(runtime as never, msg, undefined, {}, undefined);

    expect(service.calls.length).toBe(1);
    expect(service.calls[0]?.actionName).toBe("move_npc");
    expect(service.calls[0]?.parameters).toEqual({ waypoint: "spawn" });
  });

  it("parses move_npc coordinates from user message", async () => {
    const service = new FakeRobloxService();
    const runtime = {
      agentId: uuidv4() as UUID,
      getService: <T>(_name: string) => service as never as T,
    };

    const msg = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: uuidv4() as UUID,
      roomId: uuidv4() as UUID,
      content: { text: "move to (1, 2, 3)", source: "test", channelType: ChannelType.DM },
    });

    await executeGameAction.handler(runtime as never, msg, undefined, {}, undefined);

    expect(service.calls.length).toBe(1);
    expect(service.calls[0]?.actionName).toBe("move_npc");
    expect(service.calls[0]?.parameters).toEqual({ x: 1, y: 2, z: 3 });
  });
});
