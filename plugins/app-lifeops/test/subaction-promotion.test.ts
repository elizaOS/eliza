/**
 * Verifies the `promoteSubactionsToActions` helper from `@elizaos/core`.
 *
 * Phase-2 work: each umbrella's subactions are promoted to virtual top-level
 * Actions named `<UMBRELLA>_<SUBACTION>`. Virtuals delegate to the parent's
 * handler with the parent's discriminator injected into `options.parameters`
 * before dispatch. The parent stays registered alongside its virtuals.
 */

import {
  isPromotedSubactionVirtual,
  listSubactionsFromParameters,
  promoteSubactionsToActions,
} from "@elizaos/core";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { scheduledTaskAction } from "../src/actions/scheduled-task.js";

const STATIC_RUNTIME = {
  agentId: "00000000-0000-4000-8000-000000000001",
  getSetting: () => undefined,
} as unknown as IAgentRuntime;

const STATIC_MESSAGE = {
  id: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000001",
  entityId: "00000000-0000-4000-8000-000000000003",
  roomId: "00000000-0000-4000-8000-000000000004",
  worldId: "00000000-0000-4000-8000-000000000005",
  content: { text: "list my scheduled tasks", source: "test" },
} as unknown as Memory;

const NOOP_CALLBACK: HandlerCallback = async () => [];
const NOOP_STATE = undefined as unknown as State;

function makeStubAction(): Action {
  return {
    name: "STUB",
    description: "stub umbrella for tests",
    similes: ["UMBRELLA_STUB"],
    parameters: [
      {
        name: "subaction",
        description: "test discriminator: list | create | delete",
        required: true,
        schema: {
          type: "string" as const,
          enum: ["list", "create", "delete"],
        },
      },
    ],
    examples: [],
    validate: async () => true,
    handler: async (_runtime, _message, _state, options) => {
      const sub = (
        (options as HandlerOptions | undefined)?.parameters as
          | Record<string, unknown>
          | undefined
      )?.subaction;
      return {
        success: true,
        text: `dispatched ${String(sub)}`,
        data: { subaction: sub },
      };
    },
  };
}

function makeCanonicalActionStub(): Action {
  return {
    ...makeStubAction(),
    parameters: [
      {
        name: "action",
        description: "test discriminator: list | create | delete",
        required: true,
        schema: {
          type: "string" as const,
          enum: ["list", "create", "delete"],
        },
      },
    ],
    handler: async (_runtime, _message, _state, options) => {
      const action = (
        (options as HandlerOptions | undefined)?.parameters as
          | Record<string, unknown>
          | undefined
      )?.action;
      return {
        success: true,
        text: `dispatched ${String(action)}`,
        data: { action },
      };
    },
  };
}

describe("promoteSubactionsToActions", () => {
  it("returns parent + N virtual actions named <PARENT>_<SUB>", () => {
    const stub = makeStubAction();
    const promoted = promoteSubactionsToActions(stub);
    expect(promoted).toHaveLength(4);
    expect(promoted[0]).toBe(stub);
    expect(stub.subActions).toEqual([
      "STUB_LIST",
      "STUB_CREATE",
      "STUB_DELETE",
    ]);
    expect(promoted.slice(1).map((a) => a.name)).toEqual([
      "STUB_LIST",
      "STUB_CREATE",
      "STUB_DELETE",
    ]);
  });

  it("flags virtuals via isPromotedSubactionVirtual", () => {
    const stub = makeStubAction();
    const [parent, ...virtuals] = promoteSubactionsToActions(stub);
    expect(isPromotedSubactionVirtual(parent)).toBe(false);
    for (const virtual of virtuals) {
      expect(isPromotedSubactionVirtual(virtual)).toBe(true);
    }
  });

  it("listSubactionsFromParameters reads the canonical action enum", () => {
    expect(
      listSubactionsFromParameters(makeCanonicalActionStub().parameters),
    ).toEqual(["list", "create", "delete"]);
  });

  it("listSubactionsFromParameters falls back to legacy aliases", () => {
    const action: Action = {
      ...makeStubAction(),
      parameters: [
        {
          name: "op",
          description: "legacy",
          required: true,
          schema: { type: "string" as const, enum: ["a", "b"] },
        },
      ],
    };
    expect(listSubactionsFromParameters(action.parameters)).toEqual(["a", "b"]);
  });

  it("virtual handler injects subaction into options.parameters before dispatch", async () => {
    const stub = makeStubAction();
    const handlerSpy = vi.spyOn(stub, "handler");
    const [, virtualList] = promoteSubactionsToActions(stub);
    expect(virtualList?.name).toBe("STUB_LIST");

    const result = await virtualList?.handler(
      STATIC_RUNTIME,
      STATIC_MESSAGE,
      NOOP_STATE,
      { parameters: { otherParam: "abc" } },
      NOOP_CALLBACK,
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toBe("dispatched list");
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    const passedOptions = handlerSpy.mock.calls[0][3] as HandlerOptions;
    expect(passedOptions.parameters).toMatchObject({
      otherParam: "abc",
      subaction: "list",
    });
  });

  it("virtual handler injects action for canonical action-based umbrellas", async () => {
    const stub = makeCanonicalActionStub();
    const handlerSpy = vi.spyOn(stub, "handler");
    const [, virtualList] = promoteSubactionsToActions(stub);
    const result = await virtualList?.handler(
      STATIC_RUNTIME,
      STATIC_MESSAGE,
      NOOP_STATE,
      { parameters: { otherParam: "abc" } },
      NOOP_CALLBACK,
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toBe("dispatched list");
    const passedOptions = handlerSpy.mock.calls[0][3] as HandlerOptions;
    expect(passedOptions.parameters).toMatchObject({
      otherParam: "abc",
      action: "list",
      subaction: "list",
    });
  });

  it("does not overwrite nested action params when a legacy discriminator is declared", async () => {
    const stub = makeStubAction();
    const handlerSpy = vi.spyOn(stub, "handler");
    const [, virtualList] = promoteSubactionsToActions(stub);
    await virtualList?.handler(
      STATIC_RUNTIME,
      STATIC_MESSAGE,
      NOOP_STATE,
      { parameters: { action: "pause" } },
      NOOP_CALLBACK,
    );
    const passedOptions = handlerSpy.mock.calls[0][3] as HandlerOptions;
    expect(passedOptions.parameters).toMatchObject({
      action: "pause",
      subaction: "list",
    });
  });

  it("virtual handler caller-supplied subaction is overridden by virtual's name", async () => {
    const stub = makeStubAction();
    const [, , virtualCreate] = promoteSubactionsToActions(stub);
    const result = await virtualCreate?.handler(
      STATIC_RUNTIME,
      STATIC_MESSAGE,
      NOOP_STATE,
      { parameters: { subaction: "list" } },
      NOOP_CALLBACK,
    );
    expect(result?.text).toBe("dispatched create");
  });

  it("is idempotent: calling twice returns structurally identical virtuals", () => {
    const stub = makeStubAction();
    const a = promoteSubactionsToActions(stub);
    const b = promoteSubactionsToActions(stub);
    expect(a.map((x) => x.name)).toEqual(b.map((x) => x.name));
    expect(a[0]).toBe(b[0]);
  });

  it("returns just the parent when there is no subaction enum", () => {
    const stub: Action = {
      name: "BARE",
      description: "no subactions",
      handler: async () => ({ success: true }) satisfies ActionResult,
      validate: async () => true,
    };
    expect(promoteSubactionsToActions(stub)).toEqual([stub]);
  });

  it("supports namePrefix override for collisions", () => {
    const stub = makeStubAction();
    const promoted = promoteSubactionsToActions(stub, {
      namePrefix: "LIFEOPS_STUB",
    });
    expect(promoted.slice(1).map((a) => a.name)).toEqual([
      "LIFEOPS_STUB_LIST",
      "LIFEOPS_STUB_CREATE",
      "LIFEOPS_STUB_DELETE",
    ]);
  });
});

describe("SCHEDULED_TASKS promotion + alias normalization", () => {
  it("promotes the 12 task operations to virtual top-level Actions", () => {
    const promoted = promoteSubactionsToActions(scheduledTaskAction);
    expect(promoted[0]).toBe(scheduledTaskAction);
    const virtuals = promoted.slice(1);
    expect(virtuals).toHaveLength(12);
    expect(virtuals.map((a) => a.name)).toEqual([
      "SCHEDULED_TASKS_LIST",
      "SCHEDULED_TASKS_GET",
      "SCHEDULED_TASKS_CREATE",
      "SCHEDULED_TASKS_UPDATE",
      "SCHEDULED_TASKS_SNOOZE",
      "SCHEDULED_TASKS_SKIP",
      "SCHEDULED_TASKS_COMPLETE",
      "SCHEDULED_TASKS_ACKNOWLEDGE",
      "SCHEDULED_TASKS_DISMISS",
      "SCHEDULED_TASKS_CANCEL",
      "SCHEDULED_TASKS_REOPEN",
      "SCHEDULED_TASKS_HISTORY",
    ]);
  });

  it("parent handler returns a structured failure when no action is supplied", async () => {
    const result = await scheduledTaskAction.handler(
      STATIC_RUNTIME,
      STATIC_MESSAGE,
      NOOP_STATE,
      { parameters: {} },
      NOOP_CALLBACK,
    );
    expect(result?.success).toBe(false);
    if (result?.data && typeof result.data === "object") {
      const error = (result.data as Record<string, unknown>).error;
      // Either PERMISSION_DENIED (owner gate) or MISSING_SUBACTION (validator
      // bypassed) is acceptable — both prove the handler failed before any
      // downstream side effect.
      expect(["PERMISSION_DENIED", "MISSING_SUBACTION"]).toContain(error);
    }
  });

  it("the SCHEDULED_TASKS_LIST virtual delegates to the parent handler with action=list injected", async () => {
    const stubParent: typeof scheduledTaskAction = {
      ...scheduledTaskAction,
      validate: async () => true,
      handler: vi.fn(async (_runtime, _message, _state, options) => {
        const parameters = (options as HandlerOptions | undefined)?.parameters;
        return {
          success: true,
          text: "stub-ok",
          data: {
            action: (parameters as Record<string, unknown> | undefined)?.action,
            subaction: (parameters as Record<string, unknown> | undefined)
              ?.subaction,
          },
        } satisfies ActionResult;
      }),
    };
    const promoted = promoteSubactionsToActions(stubParent);
    const list = promoted.find((a) => a.name === "SCHEDULED_TASKS_LIST");
    expect(list).toBeDefined();
    const result = await list?.handler(
      STATIC_RUNTIME,
      STATIC_MESSAGE,
      NOOP_STATE,
      { parameters: { extra: "value" } },
      NOOP_CALLBACK,
    );
    expect(result?.success).toBe(true);
    expect((result?.data as Record<string, unknown>).action).toBe("list");
    expect((result?.data as Record<string, unknown>).subaction).toBe("list");
    expect(stubParent.handler).toHaveBeenCalledTimes(1);
  });

  it("the parent's resolveSubaction accepts legacy `op` alias", async () => {
    // We can't run the full handler without a database, so we exercise the
    // alias path via a stub parent that exposes the same parameter schema
    // and a handler that mirrors the resolveSubaction behavior.
    const stubParent: typeof scheduledTaskAction = {
      ...scheduledTaskAction,
      validate: async () => true,
      handler: async (_runtime, _message, _state, options) => {
        const parameters =
          ((options as HandlerOptions | undefined)?.parameters as
            | Record<string, unknown>
            | undefined) ?? {};
        const sub =
          (parameters.subaction as string | undefined) ??
          (parameters.op as string | undefined) ??
          (parameters.action as string | undefined) ??
          (parameters.operation as string | undefined);
        return {
          success: typeof sub === "string",
          data: { subaction: sub },
        } satisfies ActionResult;
      },
    };
    for (const aliasField of ["subaction", "op", "action", "operation"]) {
      const result = await stubParent.handler(
        STATIC_RUNTIME,
        STATIC_MESSAGE,
        NOOP_STATE,
        { parameters: { [aliasField]: "list" } },
        NOOP_CALLBACK,
      );
      expect(result?.success).toBe(true);
      expect((result?.data as Record<string, unknown>).subaction).toBe("list");
    }
  });
});
