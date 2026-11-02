/**
 * Real-PGlite proof that todo text containing U+0000 is stored instead of
 * failing the write. PostgreSQL rejects U+0000 in text (22021) and jsonb
 * (22P05); todo content and metadata come from the owner or a model reply.
 */

import type { AgentRuntime, UUID } from "@elizaos/core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import todosPlugin from "../src/index.ts";
import { createTodosSqlStore } from "../src/sql-store.ts";
import type { TodoScope, TodoStore } from "../src/store.ts";

const NUL = String.fromCharCode(0);

describe("Todo text with U+0000 — real PGlite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let store: TodoStore;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "todo-nul-text-real-db",
      plugins: [todosPlugin],
    });
    runtime = testResult.runtime;
    store = createTodosSqlStore(runtime.db as NodePgDatabase);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  function newScope(): TodoScope {
    return {
      agentId: crypto.randomUUID() as UUID,
      entityId: crypto.randomUUID() as UUID,
    };
  }

  it("creates a todo whose content and metadata contain U+0000", async () => {
    const scope = newScope();
    const created = await store.applyMutation({
      scope,
      idempotencyKey: "nul-create",
      mutation: {
        action: "create",
        input: {
          content: `Buy milk${NUL}`,
          metadata: { note: `from${NUL}reply`, [`k${NUL}ey`]: [`a${NUL}b`] },
        },
      },
    });
    if (created.result.action !== "create") {
      throw new Error("Expected a create result");
    }
    const [stored] = await store.list({ ...scope });
    expect(stored?.content).toBe("Buy milk");
    expect(stored?.metadata).toEqual({ note: "fromreply", key: ["ab"] });
  });

  it("updates a todo to text containing U+0000", async () => {
    const scope = newScope();
    const todo = await store.create({ ...scope, content: "Call the bank" });
    const updated = await store.update(scope, todo.id, {
      content: `Call the bank${NUL} today`,
      activeForm: `Calling${NUL} the bank`,
      metadata: { source: `voice${NUL}` },
    });
    expect(updated?.content).toBe("Call the bank today");
    expect(updated?.activeForm).toBe("Calling the bank");
    expect(updated?.metadata).toEqual({ source: "voice" });
  });

  it("writes a list whose items contain U+0000, and a replay is a no-op", async () => {
    const scope = newScope();
    const input = {
      ...scope,
      roomId: null,
      worldId: null,
      parentTrajectoryStepId: null,
      todos: [
        { content: `Pack${NUL} bags`, status: "pending" as const },
        {
          content: "Book taxi",
          activeForm: `Booking${NUL} taxi`,
          status: "in_progress" as const,
        },
      ],
    };
    const first = await store.writeList(input);
    expect(first.after.map((todo) => todo.content)).toEqual([
      "Pack bags",
      "Book taxi",
    ]);
    expect(first.after[1]?.activeForm).toBe("Booking taxi");

    // Rewriting the same list (with ids) must compare against the stored,
    // NUL-free text and leave the rows untouched rather than rewriting them.
    const replay = await store.writeList({
      ...input,
      todos: input.todos.map((item, index) => ({
        ...item,
        id: first.after[index]?.id,
      })),
    });
    expect(replay.after.map((todo) => todo.updatedAt)).toEqual(
      first.after.map((todo) => todo.updatedAt),
    );
  });
});
