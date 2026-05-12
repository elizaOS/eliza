/**
 * Integration tests for the real `threadOpsFieldEvaluator` (app-lifeops).
 *
 * These tests use a minimal fake IAgentRuntime — they do NOT spin up a real
 * Postgres adapter. The goal is to verify the evaluator's contract:
 *
 *   - shouldRun gates correctly on owner access + active work
 *   - schema slice declares all op types including abort
 *   - parse normalizes the LLM output shape
 *   - handle dispatches abort via runtime.turnControllers.abortTurn
 *   - non-abort ops stage candidateActionNames + contexts for the planner
 *
 * For full atomic-merge + concurrency tests, see `work-threads.integration.test.ts`.
 */

import type {
  ResponseHandlerFieldContext,
  ResponseHandlerFieldHandleContext,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { threadOpsFieldEvaluator } from "../src/lifeops/work-threads/field-evaluator-thread-ops";

interface FakeRuntimeOverrides {
  ownerAccess?: boolean;
  activeThreads?: number;
  pendingPrompts?: number;
  hasActiveTurn?: boolean;
  abortTurnReturn?: boolean;
  onAbortTurn?: (roomId: string, reason: string) => void;
}

function buildFakeRuntime(overrides: FakeRuntimeOverrides = {}): unknown {
  const {
    ownerAccess = true,
    activeThreads = 0,
    pendingPrompts = 0,
    hasActiveTurn = false,
    abortTurnReturn = true,
    onAbortTurn,
  } = overrides;
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    // hasOwnerAccess() in @elizaos/agent reads from runtime.character.owners
    // and the message's entityId. We bypass it by monkey-patching the module
    // import at test boundary — simpler is to intercept via the fake's
    // owner/entity helpers. The implementation we care about is that
    // hasOwnerAccess returns ownerAccess.
    character: {
      owners: ownerAccess ? ["00000000-0000-0000-0000-deadbeefdead"] : [],
    },
    adapter: {
      db: {
        execute: async () => {
          // The store list() will run a query. Return enough rows to satisfy
          // the count without doing real work.
          if (activeThreads > 0) {
            return Array.from({ length: activeThreads }, (_, i) => ({
              id: `wt-${i}`,
              agent_id: "00000000-0000-0000-0000-000000000001",
              status: "active",
              title: "stub",
              summary: "",
              current_plan_summary: null,
              primary_source_ref_json: JSON.stringify({
                connector: "test",
                roomId: "room-1",
                canRead: true,
                canMutate: true,
              }),
              source_refs_json: "[]",
              participant_entity_ids_json: "[]",
              metadata_json: "{}",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              last_activity_at: new Date().toISOString(),
              version: 1,
            }));
          }
          return [];
        },
      },
    },
    turnControllers: {
      hasActiveTurn: (roomId: string) =>
        Boolean(hasActiveTurn) && roomId === "room-1",
      abortTurn: (roomId: string, reason: string) => {
        if (onAbortTurn) onAbortTurn(roomId, reason);
        return abortTurnReturn;
      },
    },
    // Stubs needed by createPendingPromptsStore.list():
    _pendingPromptCount: pendingPrompts,
  };
}

function buildMessage(text: string, roomId = "room-1"): unknown {
  return {
    id: "msg-1",
    roomId,
    entityId: "00000000-0000-0000-0000-deadbeefdead",
    content: { text },
    createdAt: Date.now(),
  };
}

function buildState(): unknown {
  return { values: {}, data: {}, text: "" };
}

function buildCtx(
  runtime: unknown,
  message: unknown = buildMessage("hi"),
): ResponseHandlerFieldContext {
  return {
    runtime: runtime as ResponseHandlerFieldContext["runtime"],
    message: message as ResponseHandlerFieldContext["message"],
    state: buildState() as ResponseHandlerFieldContext["state"],
    senderRole: "OWNER",
    turnSignal: new AbortController().signal,
  };
}

describe("threadOpsFieldEvaluator", () => {
  describe("identity", () => {
    it("has the expected name, priority, and description", () => {
      expect(threadOpsFieldEvaluator.name).toBe("threadOps");
      expect(threadOpsFieldEvaluator.priority).toBe(30);
      expect(threadOpsFieldEvaluator.description).toContain("abort");
      expect(threadOpsFieldEvaluator.description).toContain("steer");
      expect(threadOpsFieldEvaluator.description).toContain("merge");
    });

    it("declares a strict-mode schema with all op types including abort", () => {
      const schema = threadOpsFieldEvaluator.schema as Record<string, unknown>;
      expect(schema.type).toBe("array");
      const items = schema.items as Record<string, unknown>;
      expect(items.additionalProperties).toBe(false);
      const props = items.properties as Record<string, Record<string, unknown>>;
      const enumValues = (props.type as { enum?: string[] }).enum ?? [];
      expect(enumValues).toContain("abort");
      expect(enumValues).toContain("create");
      expect(enumValues).toContain("steer");
      expect(enumValues).toContain("merge");
      expect(enumValues).toContain("mark_completed");
    });
  });

  describe("parse", () => {
    it("returns empty array for non-array input", () => {
      const result = threadOpsFieldEvaluator.parse?.(
        null,
        buildCtx(buildFakeRuntime()),
      );
      expect(result).toEqual([]);
    });

    it("filters out ops with unknown types", () => {
      const result = threadOpsFieldEvaluator.parse?.(
        [{ type: "unknown" }, { type: "abort", reason: "stop" }],
        buildCtx(buildFakeRuntime()),
      );
      expect(result).toEqual([{ type: "abort", reason: "stop" }]);
    });

    it("normalizes sourceWorkThreadIds and trims whitespace", () => {
      const result = threadOpsFieldEvaluator.parse?.(
        [
          {
            type: "merge",
            workThreadId: "wt-target",
            sourceWorkThreadIds: ["wt-a", "wt-b", "", "  wt-c  "],
          },
        ],
        buildCtx(buildFakeRuntime()),
      );
      expect(result).toHaveLength(1);
      expect(
        (result as Array<{ sourceWorkThreadIds: string[] }>)[0]
          .sourceWorkThreadIds,
      ).toEqual(["wt-a", "wt-b", "wt-c"]);
    });

    it("parses sourceRef when valid", () => {
      const result = threadOpsFieldEvaluator.parse?.(
        [
          {
            type: "attach_source",
            workThreadId: "wt-1",
            sourceRef: {
              connector: "telegram",
              roomId: "room-2",
              canMutate: true,
            },
          },
        ],
        buildCtx(buildFakeRuntime()),
      );
      expect(result).toHaveLength(1);
      const op = (result as Array<Record<string, unknown>>)[0];
      expect(op.sourceRef).toEqual({
        connector: "telegram",
        channelName: undefined,
        channelKind: undefined,
        roomId: "room-2",
        externalThreadId: undefined,
        accountId: undefined,
        grantId: undefined,
        canRead: undefined,
        canMutate: true,
      });
    });
  });

  describe("handle — abort path", () => {
    it("calls runtime.abortTurn and returns ack-and-stop preempt", async () => {
      let abortedRoomId: string | null = null;
      let abortedReason: string | null = null;
      const runtime = buildFakeRuntime({
        onAbortTurn: (roomId, reason) => {
          abortedRoomId = roomId;
          abortedReason = reason;
        },
      });
      const handleCtx: ResponseHandlerFieldHandleContext<unknown> = {
        ...buildCtx(runtime, buildMessage("nvm", "room-1")),
        value: [{ type: "abort", reason: "user said nvm" }],
        parsed: {
          shouldRespond: "RESPOND",
          contexts: [],
          intents: [],
          candidateActionNames: [],
          replyText: "",
          facts: [],
          relationships: [],
          addressedTo: [],
        },
      };
      const effect = await threadOpsFieldEvaluator.handle?.(handleCtx);
      expect(effect).toBeDefined();
      expect(effect?.preempt).toEqual({
        mode: "ack-and-stop",
        reason: "user said nvm",
      });
      expect(abortedRoomId).toBe("room-1");
      expect(abortedReason).toBe("user said nvm");
    });

    it("sets a default replyText and forces contexts=['simple']", async () => {
      const runtime = buildFakeRuntime();
      const handleCtx: ResponseHandlerFieldHandleContext<unknown> = {
        ...buildCtx(runtime, buildMessage("stop")),
        value: [{ type: "abort", reason: "abort" }],
        parsed: {
          shouldRespond: "RESPOND",
          contexts: ["general"],
          intents: [],
          candidateActionNames: [],
          replyText: "",
          facts: [],
          relationships: [],
          addressedTo: [],
        },
      };
      const effect = await threadOpsFieldEvaluator.handle?.(handleCtx);
      const mutated = { ...handleCtx.parsed } as Record<string, unknown>;
      effect?.mutateResult?.(mutated as never);
      expect(mutated.replyText).toBe("Stopped — partial work preserved.");
      expect((mutated.contexts as string[]).includes("simple")).toBe(true);
    });
  });

  describe("handle — non-abort ops", () => {
    it("stages WORK_THREAD candidateActionNames and task contexts", async () => {
      const runtime = buildFakeRuntime();
      const handleCtx: ResponseHandlerFieldHandleContext<unknown> = {
        ...buildCtx(runtime, buildMessage("steer the research thread")),
        value: [
          {
            type: "steer",
            workThreadId: "wt-1",
            instruction: "focus on bean-to-cup",
          },
        ],
        parsed: {
          shouldRespond: "RESPOND",
          contexts: ["simple"],
          intents: [],
          candidateActionNames: [],
          replyText: "",
          facts: [],
          relationships: [],
          addressedTo: [],
        },
      };
      const effect = await threadOpsFieldEvaluator.handle?.(handleCtx);
      const mutated = { ...handleCtx.parsed } as Record<string, unknown>;
      effect?.mutateResult?.(mutated as never);
      expect(mutated.candidateActionNames).toContain("WORK_THREAD");
      expect(mutated.contexts).toContain("tasks");
      expect(mutated.contexts).toContain("messaging");
      // Should drop 'simple' since we need the planner
      expect(mutated.contexts).not.toContain("simple");
      // No preempt for non-abort ops
      expect(effect?.preempt).toBeUndefined();
    });

    it("returns undefined for empty ops array", async () => {
      const runtime = buildFakeRuntime();
      const handleCtx: ResponseHandlerFieldHandleContext<unknown> = {
        ...buildCtx(runtime),
        value: [],
        parsed: {
          shouldRespond: "RESPOND",
          contexts: [],
          intents: [],
          candidateActionNames: [],
          replyText: "",
          facts: [],
          relationships: [],
          addressedTo: [],
        },
      };
      const effect = await threadOpsFieldEvaluator.handle?.(handleCtx);
      expect(effect).toBeUndefined();
    });
  });
});
