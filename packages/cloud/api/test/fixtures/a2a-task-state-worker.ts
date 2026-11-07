import { createHash } from "node:crypto";
import { runWithCloudBindings } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import {
  a2aTaskStoreService as store,
  type TaskStoreEntry,
} from "@elizaos/cloud-shared/lib/services/a2a-task-store";
import {
  type A2ATaskSnapshot,
  CloudflareA2ATaskStore,
} from "@elizaos/cloud-shared/lib/services/cloudflare-a2a-task-store";
import type { Bindings } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { A2ATaskState as ProductionA2ATaskState } from "../../src/a2a-task-state";

export class A2ATaskState extends ProductionA2ATaskState {
  constructor(private readonly fixtureState: DurableObjectState) {
    super(fixtureState);
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/fixture-imports")
      return Response.json(
        this.fixtureState.storage.sql.exec("SELECT * FROM imports").toArray(),
      );
    return super.fetch(request);
  }
}
export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    return runWithCloudBindings(env, async () => {
      const input = (await request.json()) as {
        operation: string;
        taskId: string;
        organization: string;
        entry: TaskStoreEntry;
        text: string;
        limit?: number;
        snapshots: A2ATaskSnapshot[];
      };
      try {
        switch (input.operation) {
          case "inspect-imports": {
            if (!env.A2A_TASK_STATE) throw new Error("Missing fixture binding");
            const owner = `a2a-v1:${createHash("sha256").update(input.organization).digest("hex")}`;
            return env.A2A_TASK_STATE.getByName(owner).fetch(
              "https://a2a-state.internal/fixture-imports",
            );
          }
          case "set":
            await store.set(input.taskId, input.entry);
            return Response.json(true);
          case "get":
            return Response.json(
              await store.get(input.taskId, input.organization),
            );
          case "list":
            return Response.json(
              await store.listByOrganization(input.organization, input.limit),
            );
          case "delete":
            return Response.json(
              await store.delete(input.taskId, input.organization),
            );
          case "history":
            await store.addMessageToHistory(input.taskId, input.organization, {
              role: "agent",
              parts: [{ type: "text", text: input.text }],
            });
            return Response.json(true);
          case "artifact":
            return Response.json(
              await store.addArtifact(input.taskId, input.organization, {
                parts: [{ type: "text", text: input.text }],
              }),
            );
          case "cancel":
            return Response.json(
              await store.updateTaskState(
                input.taskId,
                input.organization,
                "canceled",
              ),
            );
          case "import": {
            if (!env.A2A_TASK_STATE) throw new Error("Missing fixture binding");
            await new CloudflareA2ATaskStore(env.A2A_TASK_STATE).import(
              input.organization,
              input.snapshots,
              true,
            );
            return Response.json(true);
          }
          default:
            throw new Error("Unknown fixture operation");
        }
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.name : "unknown",
            message: error instanceof Error ? error.message : "unknown",
          },
          { status: 503 },
        );
      }
    });
  },
};
