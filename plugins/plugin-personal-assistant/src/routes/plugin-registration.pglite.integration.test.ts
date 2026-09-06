/** Exercises main-plugin route registration through real HTTP dispatch and PGlite owner records. */
import { once } from "node:events";
import { createServer } from "node:http";
import { resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { expect, it } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { LifeOpsService } from "../lifeops/service.js";
import { executeRawSql } from "../lifeops/sql.js";

it("serves owner definition CRUD from the normally registered personal-assistant plugin", async () => {
  const host = await createLifeOpsTestRuntime();
  const runtime = host.runtime;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime,
      isAuthorized: () => true,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP server omitted bound TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${base}/api/lifeops/definitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Registered owner route",
        kind: "task",
        cadence: { kind: "unscheduled" },
        timezone: "UTC",
        reminderPlan: null,
      }),
    });
    expect(created.status).toBe(201);
    const saved = await created.json();
    expect(saved.definition.title).toBe("Registered owner route");
    const read = await fetch(`${base}/api/lifeops/definitions`);
    expect(read.status).toBe(200);
    expect(
      (await read.json()).definitions.some(
        (row: { definition: { id: string } }) =>
          row.definition.id === saved.definition.id,
      ),
    ).toBe(true);
    const persisted = await new LifeOpsService(runtime, {
      ownerEntityId: resolveOwnerEntityIdOrDefault(runtime),
    }).listDefinitions();
    expect(
      persisted.some((row) => row.definition.id === saved.definition.id),
    ).toBe(true);
    const id = saved.definition.id;
    const service = new LifeOpsService(runtime, {
      ownerEntityId: resolveOwnerEntityIdOrDefault(runtime),
    });
    const todos = await (await fetch(`${base}/api/lifeops/todos`)).json();
    expect(
      todos.todos.find((todo: { id: string }) => todo.id === id),
    ).toMatchObject({
      targetKind: "definition",
      title: "Registered owner route",
      status: "pending",
      dueDate: null,
    });
    const complete = await fetch(
      `${base}/api/lifeops/definitions/${id}/complete`,
      { method: "POST" },
    );
    expect(complete.status).toBe(200);
    expect((await complete.json()).definition).toMatchObject({
      id,
      status: "completed",
      cadence: { kind: "unscheduled" },
    });
    const completedRecord = await service.getDefinition(id);
    expect(
      await service.repository.listOccurrencesForDefinition(
        runtime.agentId,
        id,
      ),
    ).toHaveLength(0);
    expect(
      (await service.getTodos()).find((todo) => todo.id === id)?.status,
    ).toBe("completed");
    const auditBeforeReplay = await executeRawSql(
      runtime,
      `SELECT * FROM app_lifeops.life_audit_events WHERE owner_id = '${id}' ORDER BY id`,
    );
    const replays = await Promise.all([
      service.completeTodo(id),
      service.completeTodo(id),
    ]);
    expect(replays.every((result) => result.replayed)).toBe(true);
    expect((await service.getDefinition(id)).definition.updatedAt).toBe(
      completedRecord.definition.updatedAt,
    );
    expect(
      await executeRawSql(
        runtime,
        `SELECT * FROM app_lifeops.life_audit_events WHERE owner_id = '${id}' ORDER BY id`,
      ),
    ).toEqual(auditBeforeReplay);
    const reopen = await fetch(`${base}/api/lifeops/definitions/${id}/reopen`, {
      method: "POST",
    });
    expect(reopen.status).toBe(200);
    expect((await reopen.json()).definition).toMatchObject({
      id,
      status: "active",
      cadence: { kind: "unscheduled" },
    });
    const raced = await Promise.all([
      service.completeTodo(id),
      service.completeTodo(id),
    ]);
    expect(raced.filter((result) => !result.replayed)).toHaveLength(1);
    expect(
      await service.repository.listOccurrencesForDefinition(
        runtime.agentId,
        id,
      ),
    ).toHaveLength(0);
    const foreign = new LifeOpsService(runtime, {
      ownerEntityId: crypto.randomUUID(),
    });
    await expect(foreign.completeTodo(id)).rejects.toThrow();
    expect((await foreign.getTodos()).some((todo) => todo.id === id)).toBe(
      false,
    );
    await service.reopenTodo(id);
    const beforeFailure = await service.getDefinition(id);
    await executeRawSql(
      runtime,
      "CREATE FUNCTION app_lifeops.reject_todo_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'definition_completed' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$",
    );
    await executeRawSql(
      runtime,
      "CREATE TRIGGER reject_todo_transition BEFORE INSERT ON app_lifeops.life_audit_events FOR EACH ROW EXECUTE FUNCTION app_lifeops.reject_todo_transition()",
    );
    try {
      await expect(service.completeTodo(id)).rejects.toMatchObject({
        code: "LIFEOPS_TODO_TRANSITION_FAILED",
      });
      expect((await service.getDefinition(id)).definition).toEqual(
        beforeFailure.definition,
      );
    } finally {
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_todo_transition ON app_lifeops.life_audit_events",
      );
      await executeRawSql(
        runtime,
        "DROP FUNCTION app_lifeops.reject_todo_transition()",
      );
    }
    const scheduled = await service.createDefinition({
      title: "Scheduled compatibility",
      kind: "task",
      cadence: {
        kind: "once",
        dueAt: new Date(Date.now() + 3600000).toISOString(),
      },
      timezone: "UTC",
      reminderPlan: null,
    });
    const scheduledOccurrences =
      await service.repository.listOccurrencesForDefinition(
        runtime.agentId,
        scheduled.definition.id,
      );
    expect(scheduledOccurrences.length).toBeGreaterThan(0);
    const scheduledTodos = (await service.getTodos()).filter(
      (todo) => todo.title === "Scheduled compatibility",
    );
    expect(scheduledTodos).toHaveLength(1);
    expect(scheduledTodos[0]).toMatchObject({
      targetKind: "occurrence",
      id: scheduledOccurrences[0].id,
    });
    await expect(
      service.completeTodo(scheduled.definition.id),
    ).rejects.toMatchObject({ code: "LIFEOPS_TODO_TRANSITION_INVALID" });
    expect(
      (await service.getDefinition(scheduled.definition.id)).definition.status,
    ).toBe("active");
    const deleted = await fetch(
      `${base}/api/lifeops/definitions/${saved.definition.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect(
      (
        await new LifeOpsService(runtime, {
          ownerEntityId: resolveOwnerEntityIdOrDefault(runtime),
        }).listDefinitions()
      ).some((row) => row.definition.id === saved.definition.id),
    ).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.cleanup();
  }
}, 180000);
