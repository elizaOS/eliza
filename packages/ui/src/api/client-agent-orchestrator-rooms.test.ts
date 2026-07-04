/**
 * Unit coverage for the orchestrator room-roster client verb. Transport stubbed,
 * no live agent.
 */
import { describe, expect, it, vi } from "vitest";
import "./client-agent";
import { ElizaClient } from "./client-base";
import type { OrchestratorRoomRosterOverview } from "./client-types";

describe("ElizaClient.getOrchestratorRooms", () => {
  it("fetches the per-room participant roster from /api/orchestrator/rooms", async () => {
    const overview: OrchestratorRoomRosterOverview = {
      rooms: [
        {
          taskId: "task-1",
          taskTitle: "Build the parser",
          status: "active",
          roomId: "room-1",
          activeAgentCount: 2,
          multiParty: true,
          participants: [
            { kind: "orchestrator", id: "orchestrator", label: "Orchestrator" },
            { kind: "user", id: "owner", label: "You" },
            {
              kind: "sub_agent",
              id: "s1",
              label: "Ada",
              framework: "claude",
              status: "tool_running",
              active: true,
              accountProviderId: "anthropic-subscription",
              accountId: "acc-1",
              accountLabel: "Work",
              totalTokens: 4200,
              usageState: "measured",
            },
          ],
        },
      ],
    };
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async (path: string) => {
      if (path === "/api/orchestrator/rooms") return overview;
      throw new Error(`unexpected path: ${path}`);
    });
    client.fetch = fetch as typeof client.fetch;

    const result = await client.getOrchestratorRooms();

    expect(fetch).toHaveBeenCalledWith("/api/orchestrator/rooms");
    expect(result.rooms[0]?.taskTitle).toBe("Build the parser");
    expect(result.rooms[0]?.multiParty).toBe(true);
    expect(result.rooms[0]?.participants).toHaveLength(3);
    expect(result.rooms[0]?.participants[2]?.accountLabel).toBe("Work");
  });
});
