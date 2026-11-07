import {
  ChannelType,
  type ResponseHandlerFieldEvaluator,
  type StructuredStreamGate,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { viewNavigationField } from "../../../../../packages/agent/src/runtime/view-navigation.ts";
import { calendarReadBindingField } from "../../../../plugin-calendar/src/read-binding.ts";
import { createNetworkActionFieldEvaluator } from "../../../../plugin-network/src/routing/structured-field.ts";
import type { NetworkStore } from "../../../../plugin-network/src/types.ts";
import { notesRequestEffectField } from "../../../../plugin-notes/src/request-effect.ts";
import { threadOpsFieldEvaluator } from "../../../../plugin-personal-assistant/src/lifeops/work-threads/field-evaluator-thread-ops.ts";
import { createStage1DirectReplyStreamGate } from "../../services/message/stage1-reply-stream.js";
import {
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
  useModelCalls,
} from "./fixtures.js";

/** The value each routing field takes on a direct answer. */
const DIRECT_ANSWER_VALUES: Record<string, unknown> = {
  shouldRespond: "RESPOND",
  contexts: ["simple"],
  intents: [],
  contextRequests: [],
  candidateActionNames: [],
  completionContext: null,
  requiresTool: false,
  replyEffectStatus: "none",
};

type OwnerRoutingField = ResponseHandlerFieldEvaluator & {
  /** The value the model writes when the turn has no such effect. */
  noEffect: unknown;
};

const ownerOnly: ResponseHandlerFieldEvaluator["shouldRun"] = ({
  senderRole,
}) => senderRole === "OWNER";

/**
 * The real plugin routing fields of an owner turn: their name, priority,
 * schema, `directReplyValue`, parse and handle are the shipped ones. Only
 * activation is replaced by an owner check, and the prompt context is
 * dropped: each plugin's own activation needs its stores, actions and
 * client, and the gate reads only the fields a call activates.
 */
const OWNER_ROUTING_FIELDS: readonly OwnerRoutingField[] = [
  { field: threadOpsFieldEvaluator, noEffect: [] },
  {
    field: createNetworkActionFieldEvaluator({
      store: {} as NetworkStore,
      authority: { memberId: "member-1", timeZone: "UTC" },
    }),
    noEffect: {
      action: "NONE",
      state: null,
      from: null,
      until: null,
      evidence: "",
    },
  },
  { field: calendarReadBindingField, noEffect: [] },
  {
    field: notesRequestEffectField,
    noEffect: { classification: "unresolved", operations: [] },
  },
  {
    field: viewNavigationField,
    noEffect: { disposition: "none", viewId: "", reason: "" },
  },
].map(({ field, noEffect }) => ({
  ...(field as ResponseHandlerFieldEvaluator),
  shouldRun: ownerOnly,
  getContext: undefined,
  noEffect,
}));

async function stage1StreamCall(
  options: {
    owner?: boolean;
    pluginFields?: readonly ResponseHandlerFieldEvaluator[];
  } = {},
) {
  const runtime = makeRuntime([
    stage1Response({
      thought: "Direct answer.",
      contexts: ["simple"],
      replyText: "Octopuses have three hearts.",
    }),
  ]);
  for (const field of options.pluginFields ?? []) {
    runtime.responseHandlerFieldRegistry.register(field);
    runtime.responseHandlerFieldEvaluators.push(field);
  }
  const message = makeMessage({
    channelType: ChannelType.DM,
    text: "tell me an octopus fact",
  });
  if (options.owner) {
    const world = {
      id: "00000000-0000-0000-0000-000000000091" as UUID,
      agentId: runtime.agentId,
      metadata: { ownership: { ownerId: message.entityId } },
    };
    runtime.getRoom = async () => ({
      id: message.roomId,
      agentId: runtime.agentId,
      worldId: world.id,
      source: "test",
      type: ChannelType.DM,
    });
    runtime.getWorld = async () => world;
  }
  await runStage1({ runtime, message });
  const params = useModelCalls(runtime)[0]?.[1] as {
    streamFieldGate?: StructuredStreamGate;
    responseSkeleton?: { spans: Array<{ key?: string }> };
    tools?: Array<{
      name?: string;
      parameters?: { properties?: Record<string, unknown> };
    }>;
  };
  const toolFields = new Set(
    Object.keys(
      params.tools?.find((tool) => tool.name === "HANDLE_RESPONSE")?.parameters
        ?.properties ?? {},
    ),
  );
  const keys = (params.responseSkeleton?.spans ?? [])
    .map((span) => span.key)
    .filter((key): key is string => typeof key === "string");
  const precedingKeys = [...new Set(keys.slice(0, keys.indexOf("replyText")))];
  return { gate: params.streamFieldGate, keys, precedingKeys, toolFields };
}

describe("Stage 1 reply stream gate", () => {
  it("opens for the fields a tool-calling provider is actually asked for when the schema drops contextRequests", async () => {
    const { gate, keys, toolFields } = await stage1StreamCall({
      owner: true,
      pluginFields: OWNER_ROUTING_FIELDS,
    });
    expect(toolFields.has("replyText")).toBe(true);
    // No reference is available on this turn, so the sent schema omits
    // contextRequests even though the field is active (Pixel 10a, Nov 2026:
    // the gate waited for it and never opened).
    expect(toolFields.has("contextRequests")).toBe(false);
    const noEffect = Object.fromEntries(
      OWNER_ROUTING_FIELDS.map((field) => [field.name, field.noEffect]),
    );
    const sentPreceding = keys
      .slice(0, keys.indexOf("replyText"))
      .filter((key) => toolFields.has(key));
    const preceding = Object.fromEntries(
      [...new Set(sentPreceding)].map((key) => [
        key,
        key in noEffect ? noEffect[key] : DIRECT_ANSWER_VALUES[key],
      ]),
    );
    expect(gate?.(preceding)).toBe(true);
  });

  it("opens for a direct answer with the fields the real Stage-1 schema writes before replyText", async () => {
    const { gate, keys, precedingKeys } = await stage1StreamCall();
    expect(gate).toBeTypeOf("function");
    expect(keys).toContain("replyText");
    // Stage 1 leaves candidateActionNames out of its schema; the gate must
    // not wait for a field the model never writes.
    expect(keys).not.toContain("candidateActionNames");
    const preceding = Object.fromEntries(
      precedingKeys.map((key) => [key, DIRECT_ANSWER_VALUES[key]]),
    );
    expect(precedingKeys.every((key) => key in DIRECT_ANSWER_VALUES)).toBe(
      true,
    );
    expect(gate?.(preceding)).toBe(true);
  });

  it("holds when the routing fields send the turn to planned work or are incomplete", async () => {
    const { gate, precedingKeys, toolFields } = await stage1StreamCall();
    const direct = Object.fromEntries(
      precedingKeys.map((key) => [key, DIRECT_ANSWER_VALUES[key]]),
    );
    expect(gate?.({ ...direct, contexts: ["calendar"] })).toBe(false);
    expect(gate?.({ ...direct, intents: ["schedule a meeting"] })).toBe(false);
    expect(gate?.({ ...direct, candidateActionNames: ["SEND_EMAIL"] })).toBe(
      false,
    );
    const { contexts: _omitted, ...withoutContexts } = direct;
    expect(gate?.(withoutContexts)).toBe(false);
    if (precedingKeys.includes("replyEffectStatus")) {
      const { replyEffectStatus: _status, ...withoutStatus } = direct;
      expect(gate?.(withoutStatus)).toBe(false);
    }
    expect(gate?.({ ...direct, contextRequests: ["history:all"] })).toBe(false);
    // The gate waits for contextRequests only when the sent schema asks for it.
    const { contextRequests: _read, ...withoutReads } = direct;
    expect(gate?.(withoutReads)).toBe(!toolFields.has("contextRequests"));
    expect(gate?.(null)).toBe(false);
  });

  it("holds when the call's schema includes a field that could reroute or rewrite the reply after it streams", () => {
    const direct = {
      shouldRespond: "RESPOND",
      contexts: ["simple"],
      contextRequests: [],
      intents: [],
      replyEffectStatus: "none",
    };
    const passive = [
      ...Object.keys(direct),
      "replyText",
      "facts",
      "relationships",
      "topics",
      "addressedTo",
      "emotion",
    ];
    const fields = (names: string[]) => () => names.map((name) => ({ name }));
    expect(createStage1DirectReplyStreamGate(fields(passive))(direct)).toBe(
      true,
    );
    expect(
      createStage1DirectReplyStreamGate(fields([...passive, "threadOps"]))(
        direct,
      ),
    ).toBe(false);
  });

  it("opens an owner's direct answer when every active plugin routing field is written first with its no-effect value", async () => {
    const { gate, keys, precedingKeys } = await stage1StreamCall({
      owner: true,
      pluginFields: OWNER_ROUTING_FIELDS,
    });
    // Each owner-gated field is active and precedes replyText.
    for (const field of OWNER_ROUTING_FIELDS) {
      expect(keys).toContain(field.name);
      expect(precedingKeys).toContain(field.name);
    }
    const noEffect = Object.fromEntries(
      OWNER_ROUTING_FIELDS.map((field) => [field.name, field.noEffect]),
    );
    const direct = Object.fromEntries(
      precedingKeys.map((key) => [
        key,
        key in noEffect ? noEffect[key] : DIRECT_ANSWER_VALUES[key],
      ]),
    );
    expect(gate?.(direct)).toBe(true);
    // A notes value in the legacy scalar form is also no effect.
    expect(gate?.({ ...direct, notesRequestEffect: "unresolved" })).toBe(true);
    // Values a real model wrote on direct-answer turns (Pixel 10a, Nov 2026):
    // a read-only Notes classification with no operations, and a navigation
    // value sent as a JSON string, which the field's parser rejects so
    // nothing is staged.
    expect(
      gate?.({
        ...direct,
        notesRequestEffect: { classification: "read_only", operations: [] },
      }),
    ).toBe(true);
    expect(gate?.({ ...direct, notesRequestEffect: "read_only" })).toBe(true);
    expect(
      gate?.({
        ...direct,
        visualContinuation:
          '{"disposition":"none","viewId":"","reason":"general question"}',
      }),
    ).toBe(true);
    // A malformed object that still names a navigation holds it: Stage-1
    // routing repair reads the raw disposition and would re-ask the model.
    for (const visualContinuation of [
      { disposition: "direct", viewId: "calendar" },
      { disposition: "planning", viewId: "calendar" },
      { disposition: "direct", viewId: "calendar", reason: "x", extra: 1 },
    ]) {
      expect(gate?.({ ...direct, visualContinuation })).toBe(false);
    }
    // An unknown top-level key the schema never asked for still holds it.
    expect(gate?.({ ...direct, viewId: "calendar" })).toBe(false);

    // A value that reroutes the turn or rewrites the reply holds it.
    for (const [field, value] of [
      [
        "notesRequestEffect",
        { classification: "mutation_requested", operations: ["create"] },
      ],
      [
        "notesRequestEffect",
        { classification: "read_only", operations: ["list"] },
      ],
      [
        "calendarReadBindings",
        [
          {
            intentId: "intent:1",
            operation: "feed",
            execution: "required",
            purpose: "requested_read",
            filterEvidence: [],
          },
        ],
      ],
      ["threadOps", [{ type: "abort", reason: "user said stop" }]],
      [
        "networkAction",
        {
          action: "SET_STATE",
          state: "paused",
          from: null,
          until: null,
          evidence: "pause my intros",
        },
      ],
      [
        "visualContinuation",
        { disposition: "direct", viewId: "calendar", reason: "open it" },
      ],
    ] as const) {
      expect(gate?.({ ...direct, [field]: value })).toBe(false);
    }
    // A routing field the model has not written yet holds it.
    const { threadOps: _threadOps, ...withoutThreadOps } = direct;
    expect(gate?.(withoutThreadOps)).toBe(false);
  });

  it("holds an owner's turn for a plugin field that declares no direct-answer value or is written after replyText", async () => {
    const { directReplyValue: _declared, ...undeclaredNotes } =
      OWNER_ROUTING_FIELDS.find(
        (field) => field.name === "notesRequestEffect",
      ) as OwnerRoutingField;
    const late: OwnerRoutingField = {
      ...(OWNER_ROUTING_FIELDS.find(
        (field) => field.name === "calendarReadBindings",
      ) as OwnerRoutingField),
      priority: 40,
    };
    for (const field of [undeclaredNotes, late]) {
      const { gate, precedingKeys } = await stage1StreamCall({
        owner: true,
        pluginFields: [field],
      });
      const direct = Object.fromEntries(
        precedingKeys.map((key) => [
          key,
          key === field.name ? field.noEffect : DIRECT_ANSWER_VALUES[key],
        ]),
      );
      expect(precedingKeys.includes(field.name)).toBe(field !== late);
      expect(gate?.(direct)).toBe(false);
    }
  });

  it("ignores owner-only plugin fields on a turn where they do not run", async () => {
    const { gate, keys, precedingKeys } = await stage1StreamCall({
      pluginFields: OWNER_ROUTING_FIELDS,
    });
    for (const field of OWNER_ROUTING_FIELDS) {
      expect(keys).not.toContain(field.name);
    }
    expect(
      gate?.(
        Object.fromEntries(
          precedingKeys.map((key) => [key, DIRECT_ANSWER_VALUES[key]]),
        ),
      ),
    ).toBe(true);
  });
});
