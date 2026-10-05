/**
 * Real-DB acceptance for addressing todos by their visible content (#29690).
 *
 * Lists and provider text never expose storage ids, so update/complete/delete
 * resolve the content the user sees (or a close paraphrase) inside the store's
 * scope-locked mutation. Ambiguity returns a clarification with stable refs and
 * mutates nothing; clear previews and needs the user's own "yes"; create asks
 * before duplicating an open todo. Every outcome is a durable mutation record,
 * so retrying a message returns its original result even after the visible
 * locator changed or disappeared. Hermetic: PGLite, no network, no LLM.
 */

import type {
  ActionResult,
  AgentRuntime,
  HandlerOptions,
  Memory,
  UUID,
} from "@elizaos/core";
import { TodosService } from "@elizaos/plugin-todos";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import { todoAction } from "../src/actions/todo.ts";
import { todoMutationsTable } from "../src/db/schema.ts";
import todosPlugin from "../src/index.ts";
import { currentTodosProvider } from "../src/providers/current-todos.ts";
import { todoRef } from "../src/todo-match.ts";

const ROOM_ID = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0" as UUID;

interface Candidate {
  ref: string;
  content: string;
  status: string;
}

describe("TODO visible-content addressing — real PGLite (#29690)", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let service: TodosService;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "todos-visible-content-tests",
      plugins: [todosPlugin],
    });
    runtime = testResult.runtime;
    service = new TodosService(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  function newEntity(): UUID {
    return crypto.randomUUID() as UUID;
  }

  function say(entityId: UUID, text: string): Memory {
    return {
      id: crypto.randomUUID() as UUID,
      entityId,
      roomId: ROOM_ID,
      content: { text },
    } as Memory;
  }

  async function run(
    message: Memory,
    parameters: Record<string, unknown>,
  ): Promise<ActionResult> {
    const result = await todoAction.handler?.(runtime, message, undefined, {
      parameters,
    } as HandlerOptions);
    if (!result) throw new Error("TODO action returned no result");
    return result;
  }

  async function rows(entityId: UUID) {
    return service.list({ entityId, agentId: runtime.agentId });
  }

  async function seed(entityId: UUID, content: string) {
    return service.create({ entityId, agentId: runtime.agentId, content });
  }

  it("completes a todo named by a paraphrase of its listed content, across turns, without ids", async () => {
    const entityId = newEntity();
    const report = await seed(entityId, "Finish the quarterly report");
    await seed(entityId, "Book dentist appointment");

    const listed = await run(say(entityId, "what's on my list?"), {
      action: "list",
    });
    const provided = await currentTodosProvider.get(
      runtime,
      say(entityId, "hi"),
      {} as never,
    );
    for (const text of [listed.text ?? "", provided.text ?? ""]) {
      expect(text).toContain("Finish the quarterly report");
      expect(text).not.toContain(report.id);
    }

    const done = await run(say(entityId, "I finished the quarterly reports"), {
      action: "complete",
      target: "finish quarterly reports",
    });
    expect(done.success).toBe(true);
    expect(done.text).toBe('Marked "Finish the quarterly report" done.');
    expect(done.effectReceipts?.[0]).toMatchObject({
      outcome: "applied",
      resource: { id: report.id },
    });
    const after = await rows(entityId);
    expect(after.find((todo) => todo.id === report.id)?.status).toBe(
      "completed",
    );
    expect(
      after.find((todo) => todo.content === "Book dentist appointment")?.status,
    ).toBe("pending");
  });

  it("returns a grounded not-found outcome and mutates nothing", async () => {
    const entityId = newEntity();
    const kept = await seed(entityId, "Water the plants");
    const result = await run(say(entityId, "delete the gym todo"), {
      action: "delete",
      target: "renew gym membership",
    });
    expect(result.success).toBe(false);
    expect(result.text).toBe(
      '[Todos] not_found: no todo matching "renew gym membership" found for this user',
    );
    expect(result.effectReceipts).toBeUndefined();
    expect((await rows(entityId)).map((todo) => todo.id)).toEqual([kept.id]);
  });

  it("never resolves content from another user's list", async () => {
    const owner = newEntity();
    const stranger = newEntity();
    const foreign = await seed(stranger, "Pay rent");
    const result = await run(say(owner, "mark pay rent done"), {
      action: "complete",
      target: "Pay rent",
    });
    expect(result.success).toBe(false);
    expect(
      (
        await service.get(
          { agentId: runtime.agentId, entityId: stranger },
          foreign.id,
        )
      )?.status,
    ).toBe("pending");
  });

  it("clarifies ambiguous duplicates with stable refs that survive list changes", async () => {
    const entityId = newEntity();
    const first = await seed(entityId, "Buy milk");
    const second = await seed(entityId, "buy milk!");

    const ambiguous = await run(say(entityId, "done with buy milk"), {
      action: "complete",
      target: "buy milk",
    });
    expect(ambiguous.success).toBe(true);
    expect(ambiguous.effectReceipts).toBeUndefined();
    expect(ambiguous.data).toMatchObject({
      clarificationRequired: true,
      awaitingUserInput: true,
    });
    const candidates = ambiguous.data?.candidates as Candidate[];
    expect(candidates.map((candidate) => candidate.content)).toEqual([
      "Buy milk",
      "buy milk!",
    ]);
    expect(candidates.map((candidate) => candidate.ref)).toEqual([
      await todoRef(first.id),
      await todoRef(second.id),
    ]);
    expect(ambiguous.text).toContain("nothing was changed");
    for (const candidate of candidates) {
      expect(ambiguous.text).toContain(candidate.ref);
      expect(ambiguous.text).not.toContain(first.id);
    }
    expect(
      (await rows(entityId)).every((todo) => todo.status === "pending"),
    ).toBe(true);

    // The list changes before the user answers: a new same-content row lands
    // and the first candidate is renamed. The ref still selects that row.
    await seed(entityId, "Buy milk");
    await service.update({ agentId: runtime.agentId, entityId }, second.id, {
      content: "Buy oat milk",
    });
    const selected = await run(say(entityId, "the second one"), {
      action: "complete",
      ref: candidates[1]?.ref,
    });
    expect(selected.success).toBe(true);
    expect(selected.text).toBe('Marked "Buy oat milk" done.');
    const state = await rows(entityId);
    expect(state.find((todo) => todo.id === second.id)?.status).toBe(
      "completed",
    );
    expect(
      state.filter((todo) => todo.status === "pending").map((t) => t.content),
    ).toEqual(expect.arrayContaining(["Buy milk", "Buy milk"]));
  });

  it("prefers an open match over a finished todo with the same content", async () => {
    const entityId = newEntity();
    const finished = await seed(entityId, "Stretch");
    await service.update({ agentId: runtime.agentId, entityId }, finished.id, {
      status: "completed",
    });
    const open = await seed(entityId, "Stretch");
    const result = await run(say(entityId, "stretched"), {
      action: "complete",
      target: "stretch",
    });
    expect(result.effectReceipts?.[0]?.resource.id).toBe(open.id);
  });

  it("keeps update's target separate from its replacement content, and a retry replays the original rename", async () => {
    const entityId = newEntity();
    const memo = await seed(entityId, "Draft memo");
    const message = say(entityId, "change draft memo to send the report");
    const params = {
      action: "update",
      target: "draft memo",
      content: "Send the quarterly report",
    };
    const renamed = await run(message, params);
    expect(renamed.text).toBe(
      'Updated "Send the quarterly report" on your list, marked to do.',
    );
    expect(renamed.effectReceipts?.[0]).toMatchObject({
      outcome: "applied",
      resource: { id: memo.id },
    });

    // The visible locator no longer exists; the same message still resolves
    // to the durable outcome instead of a fresh not-found.
    const retried = await run(message, params);
    expect(retried.success).toBe(true);
    expect(retried.text).toBe(renamed.text);
    expect(retried.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      idempotency: { replayed: true },
      resource: { id: memo.id },
    });
    expect((await rows(entityId)).map((todo) => todo.content)).toEqual([
      "Send the quarterly report",
    ]);
  });

  it("replays a delete by content after the row is gone", async () => {
    const entityId = newEntity();
    const doomed = await seed(entityId, "Cancel old subscription");
    const message = say(entityId, "remove the old subscription todo");
    const params = { action: "delete", target: "old subscription" };
    const deleted = await run(message, params);
    expect(deleted.text).toBe(
      'Deleted "Cancel old subscription" from your list.',
    );
    const retried = await run(message, params);
    expect(retried.success).toBe(true);
    expect(retried.text).toBe(deleted.text);
    expect(retried.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      idempotency: { replayed: true },
      resource: { id: doomed.id },
    });
    expect(await rows(entityId)).toEqual([]);
  });

  it("asks before duplicating an open todo and creates it only after the user's yes", async () => {
    const entityId = newEntity();
    const existing = await seed(entityId, "Call mom");

    const asked = await run(say(entityId, "add call mom"), {
      action: "create",
      content: "call Mom.",
    });
    expect(asked.success).toBe(true);
    expect(asked.effectReceipts).toBeUndefined();
    expect(asked.text).toContain('"Call mom" is already on your list');
    expect(asked.data).toMatchObject({
      duplicate: true,
      requiresConfirmation: true,
      existing: { id: existing.id },
    });
    expect(await rows(entityId)).toHaveLength(1);

    // A model-supplied repeat without the user's yes still does not duplicate.
    const repeated = await run(say(entityId, "add call mom again please"), {
      action: "create",
      content: "Call mom",
    });
    expect(repeated.data).toMatchObject({ duplicate: true });
    expect(await rows(entityId)).toHaveLength(1);

    const confirmed = await run(say(entityId, "yes"), {
      action: "create",
      content: "Call mom",
    });
    expect(confirmed.text).toBe('Added "Call mom" to your list.');
    expect(confirmed.effectReceipts?.[0]?.outcome).toBe("applied");
    expect(await rows(entityId)).toHaveLength(2);
  });

  it("does not treat a completed todo as a duplicate", async () => {
    const entityId = newEntity();
    const done = await seed(entityId, "Pack lunch");
    await service.update({ agentId: runtime.agentId, entityId }, done.id, {
      status: "completed",
    });
    const created = await run(say(entityId, "add pack lunch"), {
      action: "create",
      content: "Pack lunch",
    });
    expect(created.effectReceipts?.[0]?.outcome).toBe("applied");
  });

  it("deduplicates concurrent creates inside the store mutation", async () => {
    const entityId = newEntity();
    const scope = { agentId: runtime.agentId, entityId };
    const executions = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        service.applyMutation({
          scope,
          idempotencyKey: `concurrent-create-${index}`,
          mutation: {
            action: "create",
            input: {
              content: index % 2 === 0 ? "Renew passport" : "renew passport",
            },
            reply: "other",
          },
        }),
      ),
    );
    expect(executions.filter((execution) => execution.applied)).toHaveLength(1);
    const duplicates = executions.filter(
      (execution) =>
        execution.result.action === "create" && execution.result.duplicate,
    );
    expect(duplicates).toHaveLength(3);
    expect(await rows(entityId)).toHaveLength(1);
  });

  it("previews clear, cancels on anything but yes, and removes only the previewed rows on yes", async () => {
    const entityId = newEntity();
    await seed(entityId, "Alpha");
    await seed(entityId, "Beta");

    const preview = await run(say(entityId, "clear my todos"), {
      action: "clear",
    });
    expect(preview.success).toBe(true);
    expect(preview.effectReceipts).toBeUndefined();
    expect(preview.text).toContain("This will remove 2 todos");
    expect(preview.text).toContain('"Alpha"');
    expect(preview.text).toContain("Reply yes to confirm");
    expect(await rows(entityId)).toHaveLength(2);

    const cancelled = await run(say(entityId, "no, keep them"), {
      action: "clear",
    });
    expect(cancelled.text).toBe("Cancelled. Your list was left unchanged.");
    expect(await rows(entityId)).toHaveLength(2);

    // A bare "yes" with no open preview only previews again.
    const unprompted = await run(say(entityId, "yes"), { action: "clear" });
    expect(unprompted.data).toMatchObject({ requiresConfirmation: true });
    expect(await rows(entityId)).toHaveLength(2);

    const late = await seed(entityId, "Added after the preview");
    const confirmMessage = say(entityId, "yes, clear them");
    const cleared = await run(confirmMessage, { action: "clear" });
    expect(cleared.text).toBe("Cleared 2 todos from your list.");
    expect(cleared.effectReceipts?.[0]?.outcome).toBe("applied");
    expect((await rows(entityId)).map((todo) => todo.id)).toEqual([late.id]);

    const retried = await run(confirmMessage, { action: "clear" });
    expect(retried.text).toBe(cleared.text);
    expect(retried.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      idempotency: { replayed: true },
    });
    expect((await rows(entityId)).map((todo) => todo.id)).toEqual([late.id]);
  });

  it("refuses to confirm an expired clear preview", async () => {
    const entityId = newEntity();
    await seed(entityId, "Stale");
    await run(say(entityId, "clear everything"), { action: "clear" });
    const db = runtime.db as NodePgDatabase;
    await db
      .update(todoMutationsTable)
      .set({ committedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(todoMutationsTable.entityId, entityId));

    const answer = await run(say(entityId, "yes"), { action: "clear" });
    expect(answer.data).toMatchObject({ requiresConfirmation: true });
    expect(await rows(entityId)).toHaveLength(1);
  });
});
