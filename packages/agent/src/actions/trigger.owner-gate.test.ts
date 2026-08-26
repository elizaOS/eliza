/**
 * TRIGGER owner-privacy gate: every op resolves the sender through the REAL
 * core role machinery (canonical-owner setting / world roles / agent-self)
 * against deterministic runtime stand-ins, mirroring the OWNER_REMINDERS
 * surface. Pins the live 2026-08 leak shape: a GUEST webhook user asking
 * "list my reminders and triggers" must get the owner-private denial, never
 * the owner's trigger inventory — and must not be able to delete or toggle
 * the owner's triggers conversationally. The owner and the agent's own
 * autonomy loop keep full access, including from group rooms.
 */
import type {
  ActionParameters,
  IAgentRuntime,
  Memory,
  Task,
  UUID,
} from "@elizaos/core";
import { stringToUuid, TRIGGER_SCHEMA_VERSION } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { triggerAction } from "./trigger.ts";

const AGENT_ID = stringToUuid("trigger-gate-agent");
const OWNER_ID = stringToUuid("trigger-gate-owner");
const GUEST_ID = stringToUuid("trigger-gate-guest");
const ROOM_ID = stringToUuid("trigger-gate-shared-room");
const TASK_ID = stringToUuid("trigger-gate-task");

const DENIAL_TEXT = "Owner-private disclosure denied: owner_mismatch";

function ownerTriggerTask(): Task {
  return {
    id: TASK_ID,
    name: "TRIGGER_DISPATCH",
    description: "Trigger: take vitamins",
    roomId: ROOM_ID,
    tags: ["queue", "repeat", "trigger"],
    metadata: {
      updatedAt: Date.now(),
      trigger: {
        version: TRIGGER_SCHEMA_VERSION,
        triggerId: stringToUuid("trigger-gate-config"),
        displayName: "Trigger: take vitamins",
        instructions: "take vitamins",
        triggerType: "interval",
        enabled: true,
        wakeMode: "inject_now",
        createdBy: String(OWNER_ID),
        runCount: 0,
        intervalMs: 3_600_000,
        kind: "prompt",
      },
    },
  } as unknown as Task;
}

function makeRuntime(): {
  runtime: IAgentRuntime;
  deleteTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  getTasks: ReturnType<typeof vi.fn>;
} {
  const task = ownerTriggerTask();
  const deleteTask = vi.fn(async () => undefined);
  const updateTask = vi.fn(async () => undefined);
  const getTasks = vi.fn(async () => [task]);
  const runtime = {
    agentId: AGENT_ID,
    enableAutonomy: false,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    // Canonical owner is configured: the guest can never resolve as OWNER,
    // while the owner passes from ANY room — DMs, groups, webhook rooms.
    getSetting: (key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? String(OWNER_ID) : undefined,
    getRoom: vi.fn(async () => null),
    getService: () => null,
    getTask: vi.fn(async (id: UUID) => (id === TASK_ID ? task : null)),
    getTasks,
    createTask: vi.fn(async () => stringToUuid("trigger-gate-created")),
    updateTask,
    deleteTask,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  return { runtime, deleteTask, updateTask, getTasks };
}

function makeMessage(entityId: UUID, text: string): Memory {
  return {
    id: stringToUuid(`trigger-gate-msg-${text.slice(0, 24)}`),
    entityId,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    // A non-local connector source: an unresolved sender floors to GUEST.
    content: { text, source: "webhook" },
    createdAt: Date.now(),
  } as Memory;
}

async function run(
  runtime: IAgentRuntime,
  entityId: UUID,
  parameters: ActionParameters,
  text = "list my reminders and triggers pls",
) {
  const result = await triggerAction.handler(
    runtime,
    makeMessage(entityId, text),
    undefined,
    { parameters },
  );
  if (!result) throw new Error("expected a result");
  return result;
}

describe("TRIGGER owner-privacy gate — guests are denied every op", () => {
  it("denies a guest listing the owner's triggers (live leak shape)", async () => {
    const { runtime, getTasks } = makeRuntime();
    const result = await run(runtime, GUEST_ID, { action: "list" });
    expect(result.success).toBe(false);
    expect(result.text).toBe(DENIAL_TEXT);
    expect(result.error).toBe("TRIGGER_FORBIDDEN");
    // The polite decline matches the reminders surface and never names the
    // owner's trigger contents.
    expect(String(result.userFacingText)).toContain("owner's private info");
    expect(String(result.text)).not.toContain("take vitamins");
    // The denial happened before any store read.
    expect(getTasks).not.toHaveBeenCalled();
  });

  it("denies a guest deleting the owner's trigger", async () => {
    const { runtime, deleteTask } = makeRuntime();
    const result = await run(
      runtime,
      GUEST_ID,
      { action: "delete", taskId: String(TASK_ID) },
      "delete the vitamins reminder",
    );
    expect(result.success).toBe(false);
    expect(result.text).toBe(DENIAL_TEXT);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("denies a guest on the remaining mutating ops", async () => {
    const { runtime, updateTask } = makeRuntime();
    const attempts: ActionParameters[] = [
      { action: "create", instructions: "spam the owner", delaySeconds: 60 },
      { action: "update", taskId: String(TASK_ID), instructions: "changed" },
      { action: "run", taskId: String(TASK_ID) },
      { action: "toggle", taskId: String(TASK_ID), enabled: false },
    ];
    for (const parameters of attempts) {
      const result = await run(runtime, GUEST_ID, parameters, "do it");
      expect(result.success, JSON.stringify(parameters)).toBe(false);
      expect(result.text, JSON.stringify(parameters)).toBe(DENIAL_TEXT);
    }
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("validate hides TRIGGER from a guest's planner surface entirely", async () => {
    const { runtime } = makeRuntime();
    await expect(
      triggerAction.validate?.(
        runtime,
        makeMessage(GUEST_ID, "list my reminders and triggers pls"),
        undefined,
        { parameters: {} },
      ),
    ).resolves.toBe(false);
  });
});

describe("TRIGGER owner-privacy gate — owner and agent-self keep full access", () => {
  it("lists the owner's triggers for the owner, even in a shared room", async () => {
    const { runtime } = makeRuntime();
    const result = await run(runtime, OWNER_ID, { action: "list" });
    expect(result.success).toBe(true);
    expect(String(result.text)).toContain("take vitamins");
  });

  it("deletes for the owner", async () => {
    const { runtime, deleteTask } = makeRuntime();
    const result = await run(
      runtime,
      OWNER_ID,
      { action: "delete", taskId: String(TASK_ID) },
      "delete the vitamins reminder",
    );
    expect(result.success).toBe(true);
    expect(deleteTask).toHaveBeenCalledWith(TASK_ID);
  });

  it("toggles for the owner", async () => {
    const { runtime, updateTask } = makeRuntime();
    const result = await run(
      runtime,
      OWNER_ID,
      { action: "toggle", taskId: String(TASK_ID), enabled: false },
      "pause the vitamins reminder",
    );
    expect(result.success).toBe(true);
    expect(updateTask).toHaveBeenCalled();
  });

  it("validate keeps TRIGGER exposed for the owner at collection time", async () => {
    const { runtime } = makeRuntime();
    await expect(
      triggerAction.validate?.(
        runtime,
        makeMessage(OWNER_ID, "remind me in 3 minutes"),
        undefined,
        { parameters: {} },
      ),
    ).resolves.toBe(true);
  });

  it("agent-self (autonomy loop) passes the gate", async () => {
    const { runtime } = makeRuntime();
    const result = await run(
      runtime,
      AGENT_ID,
      { action: "list" },
      "autonomy sweep",
    );
    expect(result.success).toBe(true);
  });
});
