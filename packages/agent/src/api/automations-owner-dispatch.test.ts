import {
  deterministicOwnerEntityId,
  getHttpRuntime,
  type IAgentRuntime,
  type Task,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { workflowRoutePlugin } from "../../../../plugins/plugin-workflow/src/plugin-routes";
import { dispatchRoute } from "./dispatch-route";

describe("canonical automations route owner boundary", () => {
  it("rejects USER and missing remote principal while retaining local owner rows", async () => {
    const agentId = "00000000-0000-4000-8000-000000000001";
    const owner = deterministicOwnerEntityId(agentId);
    const trigger: Task = {
      id: "legacy-prompt" as Task["id"],
      name: "TRIGGER_DISPATCH",
      tags: ["queue", "repeat", "trigger"],
      metadata: {
        trigger: {
          triggerId: "legacy-prompt",
          displayName: "Saved prompt",
          instructions: "Return a short answer",
          triggerType: "cron",
          cronExpression: "0 12 28 9 *",
          enabled: false,
          wakeMode: "inject_now",
          createdBy: "api",
          kind: "prompt",
          runCount: 0,
        },
      },
    } as Task;
    const runtime = {
      agentId,
      character: { name: "QA" },
      getRooms: async () => [],
      getTasks: async () => [trigger],
      getService: () => null,
    } as unknown as IAgentRuntime;
    getHttpRuntime(runtime).routes =
      workflowRoutePlugin.routes?.filter(
        (route) => route.path === "/api/automations",
      ) ?? [];

    const read = (options: {
      accessContext?: {
        requesterEntityId: string;
        role: "OWNER" | "USER";
        isOwner: boolean;
        source: string;
      };
      inProcess?: boolean;
      isTrustedLocal?: boolean;
    }) =>
      dispatchRoute({
        runtime,
        method: "GET",
        path: "/api/automations",
        headers: {},
        inProcess: options.inProcess ?? false,
        isAuthorized: () => true,
        isTrustedLocal: () => options.isTrustedLocal ?? false,
        accessContext: options.accessContext as never,
      });

    expect(
      (
        await read({
          accessContext: {
            requesterEntityId: "foreign-user",
            role: "USER",
            isOwner: false,
            source: "host-session",
          },
          isTrustedLocal: true,
        })
      )?.status,
    ).toBe(403);
    expect((await read({}))?.status).toBe(403);
    const ownerResult = await read({
      accessContext: {
        requesterEntityId: owner,
        role: "OWNER",
        isOwner: true,
        source: "host-session",
      },
    });
    expect(ownerResult?.status).toBe(200);
    expect(ownerResult?.body).toMatchObject({
      automations: [{ triggerId: "legacy-prompt" }],
    });
    expect((await read({ isTrustedLocal: true }))?.status).toBe(200);
    expect((await read({ inProcess: true }))?.status).toBe(200);
  });
});
