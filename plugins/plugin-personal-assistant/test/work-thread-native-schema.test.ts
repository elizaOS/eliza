import type { ActionParameterSchema } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildPlannerToolsFromActions } from "../../../packages/core/src/actions/to-tool.js";
import {
  validateSchema,
  validateToolArgs,
} from "../../../packages/core/src/actions/validate-tool-args.js";
import {
  __INTERNAL_normalizeNativeToolsForCall as normalizeNativeToolsForCall,
  __INTERNAL_restoreRecordArgToolCalls as restoreRecordArgToolCalls,
} from "../../plugin-openai/models/text.js";
import { workThreadAction } from "../src/actions/work-thread.js";

describe.each([false, true])(
  "WORK_THREAD native arguments (Cerebras: %s)",
  (cerebrasMode) => {
    it("exposes supported operations and preserves sparse lifecycle arguments", () => {
      const normalized = normalizeNativeToolsForCall(
        buildPlannerToolsFromActions([workThreadAction]),
        { cerebrasMode },
      );
      const tools = normalized.tools;
      if (!tools) throw new Error("Missing native tools");
      const schema = (
        tools.WORK_THREAD as {
          inputSchema: { jsonSchema: ActionParameterSchema };
        }
      ).inputSchema.jsonSchema;
      const errorsFor = (operations: unknown[]) => {
        const errors: string[] = [];
        validateSchema(schema, { operations }, "", errors);
        return errors;
      };
      for (const operation of [
        { type: "create", title: "QA picnic", instruction: "Record only" },
        {
          type: "steer",
          workThreadId: "wt-1",
          instruction: "Keep it fictional",
        },
        { type: "stop", workThreadId: "wt-1" },
        { type: "mark_waiting", workThreadId: "wt-1" },
        { type: "mark_completed", workThreadId: "wt-1" },
        { type: "merge", workThreadId: "wt-1", sourceWorkThreadIds: ["wt-2"] },
        {
          type: "attach_source",
          workThreadId: "wt-1",
          sourceRef: {
            connector: "test",
            roomId: "room-1",
            canRead: true,
            canMutate: false,
          },
        },
        {
          type: "schedule_followup",
          workThreadId: "wt-1",
          instruction: "Review",
          trigger: { kind: "once", atIso: "2026-10-01T12:00:00Z" },
        },
      ]) {
        expect(
          validateToolArgs(workThreadAction, { operations: [operation] }).valid,
        ).toBe(true);
      }
      // The provider wire preserves the existing dynamic-record carrier;
      // non-Cerebras strict tools also represent omitted optionals as null.
      const nativeCreate = {
        ...(cerebrasMode
          ? {}
          : {
              workThreadId: null,
              sourceWorkThreadIds: null,
              summary: null,
              reason: null,
              sourceRef: null,
              trigger: null,
            }),
        type: "create",
        title: "QA picnic",
        instruction: "Record only",
        __eliza_record_entries: [],
      };
      if (cerebrasMode) expect(errorsFor([nativeCreate])).toEqual([]);
      const restored = restoreRecordArgToolCalls(
        [
          {
            type: "tool-call",
            toolCallId: "native-proof",
            toolName: "WORK_THREAD",
            input: { operations: [nativeCreate] },
          },
        ],
        normalized.recordArgTransformsByTool,
      );
      expect(validateToolArgs(workThreadAction, restored[0].input).valid).toBe(
        true,
      );
      // The observed live failure must be rejected before handler execution.
      expect(
        errorsFor([{ ...nativeCreate, type: "create_thread" }]).length,
      ).toBeGreaterThan(0);
      expect(
        errorsFor([{ title: "Missing operation" }]).length,
      ).toBeGreaterThan(0);
      expect(errorsFor([{ type: "create", title: 42 }]).length).toBeGreaterThan(
        0,
      );
    });
  },
);
