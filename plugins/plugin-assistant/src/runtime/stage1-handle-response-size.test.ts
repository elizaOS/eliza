/** Phone turns often reach the provider cold, so the HANDLE_RESPONSE tool's
 * absolute size is paid on every Stage 1 call, not only on a cache miss. */
import {
  createHandleResponseTool,
  type ResponseHandlerFieldEvaluator,
  ResponseHandlerFieldRegistry,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { calendarReadBindingField } from "../../../plugin-calendar/src/read-binding.ts";
import { notesRequestEffectField } from "../../../plugin-notes/src/request-effect.ts";
import { STAGE1_HANDLE_RESPONSE_TOOL_DESCRIPTION } from "../services/message/prompts.ts";
import {
  addressedToFieldEvaluator,
  contextsFieldEvaluator,
  emotionFieldEvaluator,
  intentsFieldEvaluator,
  replyEffectStatusFieldEvaluator,
  replyTextFieldEvaluator,
  shouldRespondFieldEvaluator,
} from "./builtin-field-evaluators";

/** The fields of an owner's phone chat turn, as a recorded Cerebras request
 * sent them (Nov 2026). Facts, relationships and topics do not run on mobile. */
const PHONE_TURN_FIELDS = [
  shouldRespondFieldEvaluator,
  contextsFieldEvaluator,
  intentsFieldEvaluator,
  replyEffectStatusFieldEvaluator,
  calendarReadBindingField,
  notesRequestEffectField,
  replyTextFieldEvaluator,
  addressedToFieldEvaluator,
  emotionFieldEvaluator,
] as readonly ResponseHandlerFieldEvaluator[];

/** Measured at 10,971 after the Stage 1 description trim, rounded up. Raise it only with a reason. */
const PHONE_HANDLE_RESPONSE_MAX_CHARS = 10_980;

describe("Stage 1 HANDLE_RESPONSE size", () => {
  it("keeps the serialized phone-turn tool within its measured size", () => {
    const registry = new ResponseHandlerFieldRegistry();
    for (const field of PHONE_TURN_FIELDS) registry.register(field);
    const schema = registry.composeSchema();
    // The same projection Stage 1 sends: a field without its own schema
    // description carries its prose description.
    const parameters = {
      ...schema,
      properties: Object.fromEntries(
        PHONE_TURN_FIELDS.map((field) => [
          field.name,
          field.schema.description
            ? field.schema
            : { ...field.schema, description: field.description },
        ]),
      ),
    };
    expect(Object.keys(parameters.properties).sort()).toEqual(
      [...(schema.required as string[])].sort(),
    );
    const tool = createHandleResponseTool({
      directMessage: true,
      parameters,
      description: STAGE1_HANDLE_RESPONSE_TOOL_DESCRIPTION,
    });
    expect(JSON.stringify(tool).length).toBeLessThanOrEqual(
      PHONE_HANDLE_RESPONSE_MAX_CHARS,
    );
  });
});
