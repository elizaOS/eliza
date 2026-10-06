/** Uses the real client, trigger route, normalizer and task projection; no clock runs. */
// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import type http from "node:http";
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  readTriggerConfig,
  readTriggerRuns,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
  taskToTriggerSummary,
} from "../../../../../packages/agent/src/triggers/runtime";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  normalizeTriggerDraft,
} from "../../../../../packages/agent/src/triggers/scheduling";
import {
  handleTriggerRoutes,
  type TriggerRouteContext,
} from "../../../../../plugins/plugin-workflow/src/trigger-routes";

const boundary = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../api/client", async () => {
  const { ElizaClient } = await import("../../api/client-base");
  await import("../../api/client-agent");
  const client = new ElizaClient("http://127.0.0.1:43210", "test-only-token");
  client.setRequestTransport({ request: boundary.request });
  return { client };
});
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

import { client } from "../../api/client";
import { TaskEditor } from "./TaskEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("round trips Once create/list/edit with owner identity and preserved disabled policy", async () => {
  const tasks = new Map<string, Task>();
  const owner = "11111111-1111-4111-8111-111111111111" as UUID;
  const runtime = {
    agentId: "22222222-2222-4222-8222-222222222222",
    getService: () => null,
    getRoom: async () => ({ source: "client_chat" }),
    createTask: async (task: Task) => {
      const id = randomUUID() as UUID;
      tasks.set(id, { ...task, id });
      return id;
    },
    getTask: async (id: string) => tasks.get(id) ?? null,
    updateTask: async (id: string, task: Partial<Task>) => {
      const old = tasks.get(id);
      if (old) tasks.set(id, { ...old, ...task });
    },
    getTasks: async () => [...tasks.values()],
  } as unknown as IAgentRuntime;
  const paths: string[] = [];
  boundary.request.mockImplementation(
    async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      let status = 200;
      let data: unknown;
      const handled = await handleTriggerRoutes({
        req: {} as http.IncomingMessage,
        res: {} as http.ServerResponse,
        method: init.method ?? "GET",
        pathname: parsed.pathname,
        runtime,
        ownerEntityId: owner,
        resolvePromptDeliveryRoom: async () =>
          "33333333-3333-4333-8333-333333333333" as UUID,
        localOwnerEntityId: owner,
        readJsonBody: async () => JSON.parse(String(init.body ?? "{}")),
        json: (_res, value, code) => {
          data = value;
          status = code ?? 200;
        },
        error: (_res, message, code) => {
          data = { error: message };
          status = code ?? 500;
        },
        decodePathComponent: decodeURIComponent,
        listTriggerTasks: async () => [...tasks.values()],
        readTriggerConfig,
        readTriggerRuns,
        taskToTriggerSummary,
        buildTriggerConfig,
        buildTriggerMetadata,
        normalizeTriggerDraft,
        DISABLED_TRIGGER_INTERVAL_MS,
        TRIGGER_TASK_NAME,
        TRIGGER_TASK_TAGS: [...TRIGGER_TASK_TAGS],
        executeTriggerTask: async () => {
          throw new Error("No test may execute a prompt");
        },
        getTriggerHealthSnapshot: async () => {
          throw new Error("Unused health endpoint");
        },
        getTriggerLimit: () => 20,
        triggersFeatureEnabled: () => true,
      } as TriggerRouteContext);
      return Response.json(handled ? data : { error: "Not found" }, {
        status: handled ? status : 404,
      });
    },
  );
  const saved = vi.fn();
  const ui = render(
    <TaskEditor
      initial={{ name: "One prompt", prompt: "Reply QA only" }}
      onSaved={saved}
    />,
  );
  fireEvent.change(screen.getByTestId("task-editor-scheduled-at"), {
    target: { value: "2035-10-06T11:00" },
  });
  fireEvent.click(screen.getByTestId("task-editor-save"));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(tasks.size).toBe(1);
  const stored = [...tasks.values()][0];
  expect(stored.entityId).toBe(owner);
  expect(stored.metadata?.ownership).toEqual({ ownerId: owner });
  const listed = await client.getTriggers();
  expect(listed.triggers).toHaveLength(1);
  const trigger = listed.triggers[0];
  expect(trigger).toMatchObject({
    kind: "prompt",
    triggerType: "once",
    scheduledAtIso: new Date("2035-10-06T11:00").toISOString(),
  });
  await client.updateTrigger(trigger.id, { enabled: false });
  ui.unmount();
  render(
    <TaskEditor
      initial={{
        triggerId: trigger.id,
        name: trigger.displayName,
        prompt: trigger.instructions,
        scheduleKind: "once",
        scheduledAtIso: trigger.scheduledAtIso,
        timezone: trigger.timezone,
        enabled: false,
      }}
      onSaved={saved}
    />,
  );
  fireEvent.change(screen.getByTestId("task-editor-name"), {
    target: { value: "Edited one prompt" },
  });
  fireEvent.click(screen.getByTestId("task-editor-save"));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  const after = (await client.getTriggers()).triggers[0];
  expect(tasks.size).toBe(1);
  expect(after).toMatchObject({
    id: trigger.id,
    enabled: false,
    wakeMode: "inject_now",
    scheduledAtIso: trigger.scheduledAtIso,
    displayName: "Edited one prompt",
  });
  expect(paths.every((path) => path.startsWith("/api/triggers"))).toBe(true);
});
