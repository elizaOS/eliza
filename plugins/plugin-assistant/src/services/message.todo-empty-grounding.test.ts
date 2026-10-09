/** Actual TODO list execution and production egress entry; no model, provider or database. */

import {
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  stringToUuid,
} from "@elizaos/core";
import { expect, test } from "vitest";
import { createTodoAction } from "../../../plugin-todos/src/actions/todo";
import type { TodoStore } from "../../../plugin-todos/src/store";
import type { Todo } from "../../../plugin-todos/src/types";
import {
  evaluatePlannedReplyEgress,
  resolvePlannedReplyEgress,
} from "./message/egress-policy";

function fixture() {
  const agentId = stringToUuid("todo-empty-agent");
  const entityId = stringToUuid("todo-empty-owner");
  const messageId = stringToUuid("todo-empty-message");
  const message: Memory = {
    id: messageId,
    agentId,
    entityId,
    roomId: stringToUuid("todo-empty-room"),
    content: { text: "Show a checklist and report weather only if verified." },
  };
  const calls: Parameters<TodoStore["list"]>[0][] = [];
  let rows: Todo[] = [];
  const forbidden = async (): Promise<never> => {
    throw new Error("UNREQUESTED_STORE_OPERATION");
  };
  const store: TodoStore = {
    list: async (filter) => {
      calls.push(filter);
      return rows;
    },
    applyMutation: forbidden,
    readCutoverState: forbidden,
    listMutationRecords: forbidden,
    importMutationRecords: forbidden,
    create: forbidden,
    get: forbidden,
    update: forbidden,
    delete: forbidden,
    writeList: forbidden,
    clear: forbidden,
  };
  const action = createTodoAction({ resolveStore: () => store });
  const runtime = {
    agentId,
    actions: [action],
    getSetting: () => null,
    useModel: async () => {
      throw new Error("MODEL_FORBIDDEN");
    },
  } as unknown as IAgentRuntime;
  const currentScope = { agentId, entityId, id: messageId };
  async function list(parameters: Record<string, unknown> = {}) {
    const result = await action.handler(runtime, message, undefined, {
      parameters: { action: "list", ...parameters },
    });
    if (!result) throw new Error("MISSING_ACTION_RESULT");
    return result;
  }
  function verdict(
    reply: string,
    results: ActionResult[],
    scope = currentScope,
  ) {
    return evaluatePlannedReplyEgress({
      reply,
      actionResults: results,
      actions: [action],
      currentScope: scope,
    }).verdict;
  }
  return {
    action,
    runtime,
    message,
    currentScope,
    calls,
    list,
    verdict,
    setRows: (value: Todo[]) => {
      rows = value;
    },
  };
}

test("actual scoped empty TODO read grounds production compound reply without recovery", async () => {
  const f = fixture();
  const active = await f.list();
  expect(f.calls).toEqual([
    {
      agentId: f.currentScope.agentId,
      entityId: f.currentScope.entityId,
      includeCompleted: false,
    },
  ]);
  expect(active).toMatchObject({
    success: true,
    text: "You have no active todos.",
    userFacingText: "You have no active todos.",
    emptyTrackedState: {
      resource: "todos",
      scope: "active_current_inventory",
      count: 0,
      ...{
        agentId: f.currentScope.agentId,
        entityId: f.currentScope.entityId,
        messageId: f.message.id,
      },
    },
  });
  const reply = "You have no active todos. I cannot verify current weather.";
  expect(
    await resolvePlannedReplyEgress({
      runtime: f.runtime,
      message: f.message,
      reply,
      actionResults: [active],
    }),
  ).toEqual({ text: reply, effectReceiptIds: [] });
  expect(f.verdict("Your todo list is empty.", [active])).toBe("reject");
  for (const mixedScopeReply of [
    "You have no active todos and no todos.",
    "You have no todos and no active todos.",
    "No active todos and no todos.",
    "No todos and no active todos.",
    "You have no active todos and your todo list is empty.",
    "Your todo list is empty and you have no active todos.",
    "You have no active todos and no completed todos.",
    "You have no active todos and no entire todo list entries.",
  ])
    expect(f.verdict(mixedScopeReply, [active])).toBe("reject");
  expect(
    f.verdict(reply, [active], {
      ...f.currentScope,
      entityId: stringToUuid("other-owner"),
    }),
  ).toBe("reject");
  expect(
    f.verdict(reply, [active], {
      ...f.currentScope,
      id: stringToUuid("other-turn"),
    }),
  ).toBe("reject");
  expect(
    evaluatePlannedReplyEgress({
      reply,
      actionResults: [active],
      actions: [f.action],
    }).verdict,
  ).toBe("reject");
  for (const unrelated of [
    "You have no notes.",
    "You have no reminders.",
    "Your schedule is clear.",
    "You have no active todos or reminders.",
  ])
    expect(f.verdict(unrelated, [active])).toBe("reject");

  const entire = await f.list({ includeCompleted: true, limit: 1 });
  expect(f.calls.at(-1)).toMatchObject({ includeCompleted: true, limit: 1 });
  expect(entire.emptyTrackedState).toMatchObject({
    scope: "entire_current_inventory",
  });
  expect(f.verdict("Your todo list is empty.", [entire])).toBe("allow");
  for (const unsupported of [
    "I checked. No todos or reminders.",
    "I checked. No todos yesterday.",
  ])
    expect(f.verdict(unsupported, [entire])).toBe("reject");
  const count = f.calls.length;
  expect((await f.list({ limit: 0 })).success).toBe(false);
  expect(f.calls.length).toBe(count);
});

test("TODO proof is scoped read evidence, invalidated by later matching or unknown mutation", async () => {
  const f = fixture();
  const read = await f.list();
  const observation = read.emptyTrackedState;
  if (observation?.resource !== "todos")
    throw new Error("MISSING_TODO_READ_PROOF");
  const reply = "You have no active todos.";
  for (const data of [
    { actionName: "TODO", op: "create", entityId: f.currentScope.entityId },
    { actionName: "TODO", op: "update" },
    { actionName: "TODO", op: "create", agentId: null, entityId: null },
    { actionName: "TODO", op: "create", agentId: "", entityId: "" },
    {
      actionName: "TODO",
      op: "create",
      agentId: "malformed",
      entityId: stringToUuid("other-owner"),
    },
    {
      actionName: "TODO",
      op: "clear",
      entityId: f.currentScope.entityId,
      requiresConfirmation: true,
    },
  ])
    expect(f.verdict(reply, [read, { success: true, data }])).toBe("reject");
  expect(
    f.verdict(reply, [
      read,
      {
        success: true,
        data: {
          actionName: "TODO",
          op: "create",
          agentId: f.currentScope.agentId,
          entityId: stringToUuid("other-owner"),
        },
      },
    ]),
  ).toBe("allow");
  const laterNonemptyRead: ActionResult = {
    success: true,
    data: {
      actionName: "TODO",
      op: "list",
      readOnlyOperation: true,
      agentId: f.currentScope.agentId,
      entityId: f.currentScope.entityId,
      includeCompleted: false,
      todos: [{ content: "Current active item" }],
    },
  };
  expect(f.verdict(reply, [read, laterNonemptyRead])).toBe("reject");
  const freshAfterRead = await f.list();
  expect(f.verdict(reply, [read, laterNonemptyRead, freshAfterRead])).toBe(
    "allow",
  );
  const fresh = await f.list();
  expect(
    f.verdict(reply, [
      read,
      { success: true, data: { actionName: "TODO", op: "create" } },
      fresh,
    ]),
  ).toBe("allow");
  expect(f.verdict(reply, [{ ...read, success: false }])).toBe("reject");
  expect(
    f.verdict(reply, [
      { success: true, data: { actionName: "TODO", op: "list", todos: [] } },
    ]),
  ).toBe("reject");
  expect(
    f.verdict(reply, [
      {
        ...read,
        emptyTrackedState: {
          ...observation,
          resource: "todos",
          scope: "active_current_inventory",
          count: 0,
          agentId: stringToUuid("forged-agent"),
          entityId: f.currentScope.entityId,
          messageId: f.currentScope.id,
        },
      },
    ]),
  ).toBe("reject");
  f.setRows([
    {
      id: stringToUuid("completed-todo"),
      content: "Previously finished",
      status: "completed",
    } as Todo,
  ]);
  expect(
    (await f.list({ includeCompleted: true })).emptyTrackedState,
  ).toBeUndefined();
});
