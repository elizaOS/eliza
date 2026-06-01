import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-lifeops";
import type { AgentRequestTransport } from "./transport";

function makeClientWithTransport() {
  const request = vi.fn<AgentRequestTransport["request"]>(
    async (_url, _init) =>
      new Response(
        JSON.stringify({
          goal: {
            id: "goal-1",
            title: "ship upstream patches",
            metadata: {
              lifeopsGoalStyle: {
                kind: "sprint",
                label: "Sprint",
              },
            },
          },
          links: [],
        }),
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return { client, request };
}

describe("ElizaClient LifeOps methods", () => {
  it("posts LifeOps goal creation requests to the plugin route", async () => {
    const { client, request } = makeClientWithTransport();

    const record = await client.createLifeOpsGoal({
      title: "ship upstream patches",
      metadata: {
        source: "chat_command",
        command: "/goal",
        lifeopsGoalStyle: {
          kind: "sprint",
          label: "Sprint",
        },
      },
    });

    expect(record.goal.title).toBe("ship upstream patches");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/goals",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "ship upstream patches",
          metadata: {
            source: "chat_command",
            command: "/goal",
            lifeopsGoalStyle: {
              kind: "sprint",
              label: "Sprint",
            },
          },
        }),
      }),
      { timeoutMs: 10_000 },
    );
  });
});
