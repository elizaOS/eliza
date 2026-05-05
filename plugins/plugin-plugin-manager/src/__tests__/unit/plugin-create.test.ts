import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ActionResult,
  Handler,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runCreate } from "../../actions/plugin-handlers/create";

function makeMessage(text: string, roomId = "room-1"): Memory {
  return {
    roomId: roomId as UUID,
    entityId: "00000000-0000-4000-8000-000000000001" as UUID,
    content: { text },
  } as Memory;
}

describe("PLUGIN create dispatch", () => {
  it("passes verifier policy through CREATE_TASK parameters with canonical completion proof", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "eliza-plugin-create-"));
    try {
      const templateDir = path.join(repoRoot, "eliza/packages/elizaos/templates/min-plugin");
      await mkdir(templateDir, { recursive: true });
      await writeFile(
        path.join(templateDir, "package.json"),
        '{"name":"__PLUGIN_NAME__","displayName":"__PLUGIN_DISPLAY_NAME__"}\n',
        "utf8"
      );

      const createTaskResult: ActionResult = {
        success: true,
        text: "",
        data: {
          agents: [
            {
              sessionId: "session-plugin-1",
              agentType: "codex",
              workdir: "/tmp/task-workdir",
              label: "create-plugin:plugin-push-notifications",
              status: "running",
            },
          ],
        },
      };
      const createTaskHandler = vi.fn<Handler>(async () => createTaskResult);
      const runtime = {
        agentId: "agent-1" as UUID,
        actions: [{ name: "CREATE_TASK", handler: createTaskHandler }],
        getTasks: vi.fn(async () => []),
        createTask: vi.fn(async () => "task-id"),
        deleteTask: vi.fn(async () => {}),
        getService: vi.fn(() => null),
        useModel: vi.fn(
          async () => "name: plugin-push-notifications\ndisplayName: Push Notifications Plugin"
        ),
      } as unknown as IAgentRuntime;
      const callback = vi.fn(async () => []);

      const result = await runCreate({
        runtime,
        message: makeMessage("build me a plugin for push notifications"),
        callback,
        repoRoot,
      });

      expect(result.success).toBe(true);
      expect(result.text).toContain("Task session session-plugin-1 is running");
      expect(createTaskHandler).toHaveBeenCalledTimes(1);

      const handlerOptions = createTaskHandler.mock.calls[0]?.[3] as HandlerOptions | undefined;
      const parameters = handlerOptions?.parameters;
      const task = parameters?.task;
      expect(typeof task).toBe("string");
      if (typeof task !== "string") {
        throw new Error("CREATE_TASK parameters.task must be a string");
      }
      expect(task).toContain('PLUGIN_CREATE_DONE {"pluginName":"plugin-push-notifications"');
      expect(task).toContain("bun run typecheck");
      expect(task).toContain("bun run lint");
      expect(task).toContain("bun run test");
      expect(task.includes('"testsPassed"')).toBe(false);
      expect(task.includes('"lintClean"')).toBe(false);
      expect(parameters).toMatchObject({
        label: "create-plugin:plugin-push-notifications",
        onVerificationFail: "retry",
      });
      expect(parameters?.agentType).toBeUndefined();
      expect(parameters?.env).toBeUndefined();
      expect(handlerOptions?.validator).toBeUndefined();
      expect(handlerOptions?.env).toBeUndefined();
      expect(JSON.stringify(handlerOptions).includes("ANTHROPIC_MODEL")).toBe(false);

      expect(parameters?.validator).toMatchObject({
        service: "app-verification",
        method: "verifyPlugin",
        params: {
          workdir: path.join(repoRoot, "eliza/plugins/plugin-push-notifications/typescript"),
          pluginName: "plugin-push-notifications",
          profile: "full",
        },
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
