/**
 * Exercises owner creation identity through real actions, services, and PGlite.
 * Durable replay survives runtime restart; competing and interrupted creations
 * inspect persisted rows rather than substituting a mocked repository.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActionResult,
  ElizaError,
  type Memory,
  ModelType,
  type UUID,
} from "@elizaos/core";
import type { CreateLifeOpsDefinitionRequest } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { ownerTodosAction } from "../actions/owner-surfaces.js";
import { LifeOpsService } from "./service.js";
import { executeRawSql } from "./sql.js";

function request(
  title: string,
  idempotencyKey?: string,
): CreateLifeOpsDefinitionRequest {
  return {
    title,
    idempotencyKey,
    kind: "task",
    cadence: { kind: "unscheduled" },
    timezone: "UTC",
    reminderPlan: null,
  };
}

describe("durable owner definition creation identity", () => {
  let host: RealTestRuntimeResult;
  let service: LifeOpsService;
  let directory: string;
  const characterName = "GuardianCreationIdentity";
  async function start() {
    host = await createLifeOpsTestRuntime({
      characterName,
      pgliteDir: directory,
      removePgliteDirOnCleanup: false,
    });
    service = new LifeOpsService(host.runtime, {
      ownerEntityId: host.runtime.agentId,
    });
    host.runtime.registerModel(
      ModelType.TEXT_SMALL,
      async () => "The owner operation completed.",
      "idempotency-test-renderer",
    );
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "guardian-definition-identity-"));
    await start();
  }, 180_000);
  afterAll(async () => {
    if (host) await host.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("upgrades an existing audit table without changing its historical rows", async () => {
    await executeRawSql(
      host.runtime,
      `INSERT INTO app_lifeops.life_audit_events (id, agent_id, event_type, owner_type, owner_id, created_at) VALUES ('legacy-creation-audit', '${host.runtime.agentId}', 'definition_created', 'definition', 'legacy-definition', '2026-01-01T00:00:00.000Z')`,
    );
    await executeRawSql(
      host.runtime,
      "ALTER TABLE app_lifeops.life_audit_events DROP COLUMN idempotency_key CASCADE",
    );
    await host.cleanup();
    await start();
    const created = await service.createDefinition(
      request("Migrated operation", "migrated"),
    );
    const replay = await service.createDefinition(
      request("Migrated operation", "migrated"),
    );
    expect(replay.definition.id).toBe(created.definition.id);
    const historical = await executeRawSql(
      host.runtime,
      "SELECT owner_id, event_type, idempotency_key FROM app_lifeops.life_audit_events WHERE id = 'legacy-creation-audit'",
    );
    expect(historical).toEqual([
      {
        owner_id: "legacy-definition",
        event_type: "definition_created",
        idempotency_key: null,
      },
    ]);
  }, 180_000);

  it("replays one key, preserves intentional twins, and rejects changed payload reuse", async () => {
    const original = await service.createDefinition(
      request("Intentional twins", "first"),
    );
    const replay = await service.createDefinition(
      request("Intentional twins", "first"),
    );
    const twin = await service.createDefinition(
      request("Intentional twins", "second"),
    );
    expect(replay.definition.id).toBe(original.definition.id);
    expect(replay.idempotency).toEqual({
      key: original.idempotency.key,
      replayed: true,
    });
    expect(twin.definition.id).not.toBe(original.definition.id);
    expect(
      (await service.listDefinitions()).filter(
        (row) => row.definition.title === "Intentional twins",
      ),
    ).toHaveLength(2);
    await expect(
      service.createDefinition(request("Changed payload", "first")),
    ).rejects.toMatchObject({
      code: "LIFEOPS_DEFINITION_IDEMPOTENCY_CONFLICT",
    });
  });

  it("elects a single creator across concurrent service instances", async () => {
    const other = new LifeOpsService(host.runtime, {
      ownerEntityId: host.runtime.agentId,
    });
    const outcomes = await Promise.allSettled([
      service.createDefinition(request("Concurrent", "concurrent")),
      other.createDefinition(request("Concurrent", "concurrent")),
    ]);
    const completed = outcomes.filter(
      (result) => result.status === "fulfilled",
    );
    expect(completed.length).toBeGreaterThanOrEqual(1);
    for (const result of outcomes)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({
          code: "LIFEOPS_DEFINITION_CREATION_INCOMPLETE",
        });
    const replay = await other.createDefinition(
      request("Concurrent", "concurrent"),
    );
    expect(replay.idempotency.replayed).toBe(true);
    expect(
      (await service.listDefinitions()).filter(
        (row) => row.definition.title === "Concurrent",
      ),
    ).toHaveLength(1);
  });

  it("keeps owner namespaces distinct even when the caller key matches", async () => {
    const other = new LifeOpsService(host.runtime, {
      ownerEntityId: "22222222-2222-4222-8222-222222222222",
    });
    const mine = await service.createDefinition(
      request("Scoped identity", "same-owner-key"),
    );
    const theirs = await other.createDefinition(
      request("Scoped identity", "same-owner-key"),
    );
    expect(theirs.definition.id).not.toBe(mine.definition.id);
    expect(theirs.idempotency.key).not.toBe(mine.idempotency.key);
    expect(
      (await service.listDefinitions()).some(
        (row) => row.definition.id === theirs.definition.id,
      ),
    ).toBe(false);
  });

  it("binds acting owners independently when they create in the same agent scope", async () => {
    const other = new LifeOpsService(host.runtime, {
      ownerEntityId: "22222222-2222-4222-8222-222222222222",
    });
    const operation = {
      ...request("Agent scoped copy", "same-agent-key"),
      ownership: { domain: "agent_ops" as const },
    };
    const mine = await service.createDefinition(operation);
    const theirs = await other.createDefinition(operation);
    expect(theirs.definition.subjectId).toBe(mine.definition.subjectId);
    expect(theirs.definition.id).not.toBe(mine.definition.id);
    expect(theirs.idempotency.key).not.toBe(mine.idempotency.key);
    const replay = await service.createDefinition(operation);
    expect(replay.definition.id).toBe(mine.definition.id);
    expect(replay.idempotency.replayed).toBe(true);
  });

  it("preserves distinct owner action copies and returns a replay receipt for a retry", async () => {
    const message: Memory = {
      id: crypto.randomUUID() as UUID,
      agentId: host.runtime.agentId,
      entityId: host.runtime.agentId,
      roomId: crypto.randomUUID() as UUID,
      content: {
        source: "dashboard",
        text: "Create two separate identical todos named Owner copies. Both have no deadline. Then update the first copy description and delete only that first copy, retaining the second.",
      },
    };
    async function create(idempotencyKey: string): Promise<ActionResult> {
      const result = await ownerTodosAction.handler(
        host.runtime,
        message,
        undefined,
        {
          parameters: {
            action: "create",
            kind: "definition",
            title: "Owner copies",
            idempotencyKey,
            details: {
              cadence: { kind: "unscheduled" },
              kind: "task",
              timeZone: "UTC",
            },
          },
        },
      );
      if (!result || typeof result !== "object")
        throw new Error("Owner action returned no result");
      return result;
    }
    const first = await create("owner-copy-1");
    const second = await create("owner-copy-2");
    const retry = await create("owner-copy-1");
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(retry.success).toBe(true);
    expect(first.effectReceipts?.[0].outcome).toBe("applied");
    expect(retry.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      idempotency: {
        key: first.effectReceipts?.[0].idempotency.key,
        replayed: true,
      },
    });
    expect(
      (await service.listDefinitions()).filter(
        (row) => row.definition.title === "Owner copies",
      ),
    ).toHaveLength(2);
    const firstId = first.effectReceipts?.[0].resource.id;
    expect(firstId).toBeTruthy();
    const foreignOwner = new LifeOpsService(host.runtime, {
      ownerEntityId: "22222222-2222-4222-8222-222222222222",
    });
    const foreign = await foreignOwner.createDefinition(
      request("Owner copies", "foreign-copy"),
    );
    const denied = await ownerTodosAction.handler(
      host.runtime,
      message,
      undefined,
      {
        parameters: {
          action: "update",
          kind: "definition",
          title: "Owner copies",
          target: foreign.definition.id,
          details: { description: "Unauthorized replacement" },
        },
      },
    );
    expect(denied).toMatchObject({ success: false });
    expect(denied).not.toMatchObject({ data: { readOnlyOperation: true } });
    const beforeMissingRead = await service.listDefinitions();
    const missingRead = await ownerTodosAction.handler(
      host.runtime,
      message,
      undefined,
      {
        parameters: {
          action: "review",
          kind: "definition",
          target: "missing-exact-target",
        },
      },
    );
    expect(missingRead).toMatchObject({
      success: false,
      data: { readOnlyOperation: true },
      effectReceipts: [
        { outcome: "failed", failure: { acceptance: "rejected" } },
      ],
    });
    expect(await service.listDefinitions()).toEqual(beforeMissingRead);
    expect(
      (await foreignOwner.getDefinition(foreign.definition.id)).definition
        .description,
    ).not.toBe("Unauthorized replacement");
    const update = await ownerTodosAction.handler(
      host.runtime,
      message,
      undefined,
      {
        parameters: {
          action: "update",
          kind: "definition",
          title: "Owner copies",
          target: firstId,
          details: { description: "First copy changed" },
        },
      },
    );
    expect(update).toMatchObject({ success: true });
    const updated = (await service.listDefinitions()).filter(
      (row) => row.definition.title === "Owner copies",
    );
    expect(
      updated.find((row) => row.definition.id === firstId)?.definition
        .description,
    ).toBe("First copy changed");
    expect(
      updated.find((row) => row.definition.id !== firstId)?.definition
        .description,
    ).not.toBe("First copy changed");
    const deleted = await ownerTodosAction.handler(
      host.runtime,
      message,
      undefined,
      {
        parameters: {
          action: "delete",
          kind: "definition",
          target: firstId,
        },
      },
    );
    expect(deleted).toMatchObject({ success: true });
    const remaining = (await service.listDefinitions()).filter(
      (row) => row.definition.title === "Owner copies",
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].definition.id).not.toBe(firstId);
  });

  it("retains creation identity across a missing-schedule draft and owner clarification", async () => {
    host.runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () =>
        '\n\n{\n  "mode": "respond",\n  "response": "What title should the twin todo use?",\n  "requestKind": null,\n  "title": null,\n  "description": null,\n  "cadenceKind": null,\n  "windows": null,\n  "weekdays": null,\n  "timeOfDay": null,\n  "timeZone": null,\n  "everyMinutes": null,\n  "timesPerDay": null,\n  "quotaTargetCount": null,\n  "quotaUnit": null,\n  "perOccurrenceWork": null,\n  "checkInRequested": null,\n  "checkInWindows": null,\n  "priority": null,\n  "durationMinutes": null,\n  "dueDate": null,\n  "dueInDays": null,\n  "dueWeekday": null,\n  "dueInMinutes": null,\n  "multiStep": false\n}',
      "idempotency-test-extractor",
    );
    const message: Memory = {
      id: crypto.randomUUID() as UUID,
      agentId: host.runtime.agentId,
      entityId: host.runtime.agentId,
      roomId: crypto.randomUUID() as UUID,
      content: {
        source: "dashboard",
        text: "Create a todo called Pending schedule.",
      },
    };
    const preview = await ownerTodosAction.handler(
      host.runtime,
      message,
      undefined,
      {
        parameters: {
          action: "create",
          kind: "definition",
          title: "Pending schedule",
          idempotencyKey: "draft-identity",
        },
      },
    );
    expect(preview).toMatchObject({
      success: false,
      data: { awaitingUserInput: true },
    });
    expect(
      (await service.listDefinitions()).filter(
        (row) => row.definition.title === "Pending schedule",
      ),
    ).toHaveLength(0);
    const saved = await ownerTodosAction.handler(
      host.runtime,
      {
        ...message,
        id: crypto.randomUUID() as UUID,
        content: {
          source: "dashboard",
          text: "No deadline, no reminder, no schedule. Save it as an undated todo.",
        },
      },
      undefined,
      {
        parameters: {
          action: "create",
          kind: "definition",
          details: {
            cadence: { kind: "unscheduled" },
            kind: "task",
            timeZone: "UTC",
          },
        },
      },
    );
    expect(saved).toMatchObject({ success: true });
    if (!saved || typeof saved !== "object")
      throw new Error("Owner returned no save result");
    const key = saved.effectReceipts?.[0].idempotency.key;
    if (typeof key !== "string")
      throw new Error("Save omitted operation identity");
    if (!preview || typeof preview !== "object")
      throw new Error("Owner returned no preview");
    expect(preview.effectReceipts?.[0].idempotency.key).toBe(key);
    expect(preview.effectReceipts?.[0].operation).toBe(
      saved.effectReceipts?.[0].operation,
    );
    expect(JSON.parse(key).at(-1)).toBe("draft-identity");
    expect(
      (await service.listDefinitions()).filter(
        (row) => row.definition.title === "Pending schedule",
      ),
    ).toHaveLength(1);
  });

  it("survives runtime restart without another creation and reports an interrupted write honestly", async () => {
    const stable = await service.createDefinition(
      request("Restart proof", "restart"),
    );
    await executeRawSql(
      host.runtime,
      `CREATE FUNCTION app_lifeops.guardian_fail_creation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'definition_created' THEN RAISE EXCEPTION 'injected audit outage after definition persistence'; END IF; RETURN NEW; END $$`,
    );
    await executeRawSql(
      host.runtime,
      `CREATE TRIGGER guardian_creation_audit_failure BEFORE INSERT ON app_lifeops.life_audit_events FOR EACH ROW EXECUTE FUNCTION app_lifeops.guardian_fail_creation_audit()`,
    );
    try {
      await expect(
        service.createDefinition(
          request("Interrupted creation", "interrupted"),
        ),
      ).rejects.toThrow();
    } finally {
      await executeRawSql(
        host.runtime,
        "DROP TRIGGER guardian_creation_audit_failure ON app_lifeops.life_audit_events",
      );
      await executeRawSql(
        host.runtime,
        "DROP FUNCTION app_lifeops.guardian_fail_creation_audit()",
      );
    }
    const interrupted = (await service.listDefinitions()).filter(
      (row) => row.definition.title === "Interrupted creation",
    );
    expect(interrupted).toHaveLength(1);
    await host.cleanup();
    await start();
    const replay = await service.createDefinition(
      request("Restart proof", "restart"),
    );
    expect(replay.definition.id).toBe(stable.definition.id);
    expect(replay.idempotency.replayed).toBe(true);
    await expect(
      service.createDefinition(request("Interrupted creation", "interrupted")),
    ).rejects.toMatchObject({
      code: "LIFEOPS_DEFINITION_CREATION_INCOMPLETE",
      context: { definitionId: interrupted[0].definition.id, retryable: false },
    });
    expect(
      (await service.listDefinitions()).filter(
        (row) => row.definition.title === "Interrupted creation",
      ),
    ).toHaveLength(1);
  }, 180_000);

  it("retains consumed identity after deletion without resurrecting the record", async () => {
    const created = await service.createDefinition(
      request("Deleted operation", "deleted"),
    );
    await service.deleteDefinition(created.definition.id);
    await expect(
      service.createDefinition(request("Deleted operation", "deleted")),
    ).rejects.toMatchObject({
      code: "LIFEOPS_DEFINITION_CREATION_RESOURCE_UNAVAILABLE",
    });
    expect(
      (await service.listDefinitions()).filter(
        (row) => row.definition.title === "Deleted operation",
      ),
    ).toHaveLength(0);
    const replacement = await service.createDefinition(
      request("Deleted operation", "replacement"),
    );
    expect(replacement.definition.id).not.toBe(created.definition.id);
  });

  it("rolls back the claim when the first database write fails and permits a safe retry", async () => {
    await executeRawSql(
      host.runtime,
      `CREATE FUNCTION app_lifeops.guardian_fail_definition_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected pre-write outage'; END $$`,
    );
    await executeRawSql(
      host.runtime,
      `CREATE TRIGGER guardian_definition_insert_failure BEFORE INSERT ON app_lifeops.life_task_definitions FOR EACH ROW EXECUTE FUNCTION app_lifeops.guardian_fail_definition_insert()`,
    );
    try {
      await expect(
        service.createDefinition(request("Safe retry", "safe-retry")),
      ).rejects.toThrow();
    } finally {
      await executeRawSql(
        host.runtime,
        "DROP TRIGGER guardian_definition_insert_failure ON app_lifeops.life_task_definitions",
      );
      await executeRawSql(
        host.runtime,
        "DROP FUNCTION app_lifeops.guardian_fail_definition_insert()",
      );
    }
    expect(
      (await service.listDefinitions()).filter(
        (row) => row.definition.title === "Safe retry",
      ),
    ).toHaveLength(0);
    const retried = await service.createDefinition(
      request("Safe retry", "safe-retry"),
    );
    expect(retried.idempotency.replayed).toBe(false);
    expect(
      (await service.listDefinitions()).filter(
        (row) => row.definition.title === "Safe retry",
      ),
    ).toHaveLength(1);
  });

  it("compares complete structured arguments independently of object key order", async () => {
    const created = await service.createDefinition({
      ...request("Canonical arguments", "canonical"),
      metadata: { alpha: 1, nested: { x: "same", y: true } },
    });
    const replay = await service.createDefinition({
      ...request("Canonical arguments", "canonical"),
      metadata: { nested: { y: true, x: "same" }, alpha: 1 },
    });
    expect(replay.definition.id).toBe(created.definition.id);
    expect(replay.idempotency.replayed).toBe(true);
    await expect(
      service.createDefinition({
        ...request("Canonical arguments", "canonical"),
        metadata: { alpha: 1, nested: { x: "changed", y: true } },
      }),
    ).rejects.toMatchObject({
      code: "LIFEOPS_DEFINITION_IDEMPOTENCY_CONFLICT",
    });
  });

  it.each(["", "bad\0key", "x".repeat(257)])(
    "rejects malformed creation identity before persisting",
    async (key) => {
      const before = await service.listDefinitions();
      await expect(
        service.createDefinition(request("Invalid identity", key)),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ElizaError &&
          error.code === "LIFEOPS_DEFINITION_IDEMPOTENCY_KEY_INVALID",
      );
      expect(await service.listDefinitions()).toEqual(before);
    },
  );
  it("a foreign exact ID cannot retarget the only same-title local item", async () => {
    const mine = await service.createDefinition(
      request("Review unique target", "review-mine"),
    );
    const other = new LifeOpsService(host.runtime, {
      ownerEntityId: "33333333-3333-4333-8333-333333333333",
    });
    const theirs = await other.createDefinition(
      request("Review unique target", "review-theirs"),
    );
    const result = await ownerTodosAction.handler(
      host.runtime,
      {
        id: crypto.randomUUID() as UUID,
        agentId: host.runtime.agentId,
        entityId: host.runtime.agentId,
        roomId: crypto.randomUUID() as UUID,
        content: {
          source: "dashboard",
          text: "Update Review unique target description.",
        },
      },
      undefined,
      {
        parameters: {
          action: "update",
          kind: "definition",
          target: theirs.definition.id,
          details: { description: "WRONG TARGET WRITE" },
        },
      },
    );
    expect(
      (await service.getDefinition(mine.definition.id)).definition.description,
    ).toBe(mine.definition.description);
    expect(result).toMatchObject({ success: false });
  });
  it("identical keyed action retry survives changed wrapper message", async () => {
    const base = {
      agentId: host.runtime.agentId,
      entityId: host.runtime.agentId,
      roomId: crypto.randomUUID() as UUID,
    };
    const args = {
      parameters: {
        action: "create",
        kind: "definition",
        title: "Review wrapper retry",
        idempotencyKey: "review-wrapper",
        details: {
          kind: "task",
          cadence: { kind: "unscheduled" },
          timeZone: "UTC",
        },
      },
    };
    const first = await ownerTodosAction.handler(
      host.runtime,
      {
        ...base,
        id: crypto.randomUUID() as UUID,
        content: {
          source: "dashboard",
          text: "Create Review wrapper retry with no deadline.",
        },
      },
      undefined,
      args,
    );
    const second = await ownerTodosAction.handler(
      host.runtime,
      {
        ...base,
        id: crypto.randomUUID() as UUID,
        content: {
          source: "dashboard",
          text: "Retry the same creation of Review wrapper retry with no deadline.",
        },
      },
      undefined,
      args,
    );
    expect(first).toMatchObject({ success: true });
    expect(second).toMatchObject({
      success: true,
      effectReceipts: [{ outcome: "noop", idempotency: { replayed: true } }],
    });
    const persisted = (await service.listDefinitions()).find(
      (row) => row.definition.title === "Review wrapper retry",
    );
    expect(persisted?.definition.originalIntent).toBe(
      "Create Review wrapper retry with no deadline.",
    );
  });

  it("an explicit keep cue prevents mutation through scored fallback", async () => {
    const mine = await service.createDefinition(
      request("Review protected single", "review-protected"),
    );
    const result = await ownerTodosAction.handler(
      host.runtime,
      {
        id: crypto.randomUUID() as UUID,
        agentId: host.runtime.agentId,
        entityId: host.runtime.agentId,
        roomId: crypto.randomUUID() as UUID,
        content: {
          source: "dashboard",
          text: "Keep Review protected single unchanged.",
        },
      },
      undefined,
      {
        parameters: {
          action: "update",
          kind: "definition",
          target: mine.definition.id,
          details: { description: "KEEP CUE VIOLATED" },
        },
      },
    );
    expect(
      (await service.getDefinition(mine.definition.id)).definition.description,
    ).toBe(mine.definition.description);
    expect(result).toMatchObject({ success: false });
  });
  it("rejects a changed explicit intent while retaining the original complete provenance", async () => {
    const message: Memory = {
      id: crypto.randomUUID() as UUID,
      agentId: host.runtime.agentId,
      entityId: host.runtime.agentId,
      roomId: crypto.randomUUID() as UUID,
      content: {
        source: "dashboard",
        text: "Create an undated todo and keep this complete original request as provenance.",
      },
    };
    const parameters = {
      action: "create",
      kind: "definition",
      title: "Explicit intent",
      idempotencyKey: "explicit-intent",
      intent: "Prepare the first authorized item with no deadline",
      details: {
        kind: "task",
        cadence: { kind: "unscheduled" },
        timeZone: "UTC",
      },
    };
    await ownerTodosAction.handler(host.runtime, message, undefined, {
      parameters,
    });
    await expect(
      ownerTodosAction.handler(
        host.runtime,
        { ...message, id: crypto.randomUUID() as UUID },
        undefined,
        {
          parameters: {
            ...parameters,
            intent: "Prepare a different authorized item with no deadline",
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "LIFEOPS_DEFINITION_IDEMPOTENCY_CONFLICT",
    });
    const persisted = (await service.listDefinitions()).find(
      (row) => row.definition.title === "Explicit intent",
    );
    expect(persisted?.definition.originalIntent).toBe(parameters.intent);
  });
});
