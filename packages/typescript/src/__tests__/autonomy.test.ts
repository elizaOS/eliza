import { v4 as uuidv4 } from "uuid";
import { describe, expect, test } from "vitest";
import { AutonomyService } from "../autonomy/service";
import type { IAgentRuntime, Memory, UUID } from "../types";

const asTestUuid = (id: string): UUID => id as UUID;

const makeMemory = (
  id: UUID,
  entityId: UUID,
  roomId: UUID,
  text: string,
  createdAt: number,
): Memory => ({
  id,
  entityId,
  roomId,
  content: { text },
  createdAt,
});

describe("autonomy service", () => {
  test("dedupes target room context by earliest message id", async () => {
    const roomId = asTestUuid(uuidv4());
    const agentId = asTestUuid(uuidv4());
    const dupId = asTestUuid(uuidv4());

    const runtime = {
      agentId,
      getSetting: (key: string) =>
        key === "AUTONOMY_TARGET_ROOM_ID" ? roomId : undefined,
      getMemories: async ({ tableName }: { tableName: string }) => {
        if (tableName === "memories") {
          return [makeMemory(dupId, agentId, roomId, "old", 10)];
        }
        return [makeMemory(dupId, agentId, roomId, "new", 20)];
      },
      logger: { info: () => undefined, debug: () => undefined },
    } as IAgentRuntime;

    const service = new AutonomyService() as AutonomyService & {
      getTargetRoomContextText: () => Promise<string>;
      runtime: IAgentRuntime;
    };
    service.runtime = runtime;

    const context = await service.getTargetRoomContextText();
    expect(context).toContain("old");
    expect(context).not.toContain("new");
  });
});
