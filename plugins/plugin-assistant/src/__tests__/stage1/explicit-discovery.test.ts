import {
  normalizeActionJsonSchema,
  promoteSubactionsToActions,
} from "@elizaos/core";
import type { Action } from "@elizaos/core/protocol";
import {
  ChannelType,
  type JSONSchema,
  ModelType,
  type UUID,
} from "@elizaos/core/protocol";
import { describe, expect, it, vi } from "vitest";
import { runV5MessageRuntimeStage1 } from "../../services/message.js";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "./fixtures.js";

describe("explicit discovery survives planner surface construction", () => {
  it.each([false, true])(
    "discovers an authorized family outside a fully selected route with unknown hint=%s",
    async (unknownHint) => {
      const hash = vi.fn(async () => ({ success: true, text: "hash receipt" }));
      const fetchPage = vi.fn(async () => ({
        success: true,
        text: "Example Domain receipt",
      }));
      const runtime = makeRuntime([
        stage1Response({
          contexts: ["terminal", "web"],
          candidateActionNames: unknownHint
            ? ["HASH_CONTEXT_TEXT", "WEB_FETCH"]
            : ["HASH_CONTEXT_TEXT"],
          intents: ["hash the text", "fetch the page"],
          replyText: "Running both checks.",
          extra: { replyEffectStatus: "pending" },
        }),
        {
          text: "",
          toolCalls: [
            {
              id: "discover-fetch",
              name: "DISCOVER_ACTIONS",
              arguments: {
                names: ["FETCH_EXAMPLE_PAGE"],
                eliza_turn_scope: "more_work_pending",
              },
            },
          ],
        },
        {
          text: "",
          toolCalls: [
            {
              id: "hash",
              name: "HASH_CONTEXT_TEXT",
              arguments: { eliza_turn_scope: "more_work_pending" },
            },
          ],
        },
        JSON.stringify({
          decision: "CONTINUE",
          success: false,
          thought: "The page fetch remains pending.",
        }),
        {
          text: "",
          toolCalls: [
            {
              id: "fetch",
              name: "FETCH_EXAMPLE_PAGE",
              arguments: { eliza_turn_scope: "final" },
            },
          ],
        },
        JSON.stringify({
          decision: "FINISH",
          success: true,
          thought: "Both receipts verified.",
          messageToUser: "Both checks completed.",
        }),
      ]);
      runtime.actions = [
        {
          name: "HASH_CONTEXT_TEXT",
          description: "Hash the requested text.",
          contexts: ["terminal"],
          similes: [],
          examples: [],
          parameters: [],
          validate: async () => true,
          handler: hash,
        },
        {
          name: "FETCH_EXAMPLE_PAGE",
          description: "Fetch the requested page.",
          contexts: ["general"],
          similes: [],
          examples: [],
          parameters: [],
          validate: async () => true,
          handler: fetchPage,
        },
      ] as never;
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({
          text: "Hash the text and fetch example.com using both tools.",
          channelType: ChannelType.DM,
        }),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000009" as UUID,
      });
      expect(hash).toHaveBeenCalledTimes(1);
      expect(fetchPage).toHaveBeenCalledTimes(1);
      const calls = useModelCalls(runtime);
      const initial = calls.find(
        ([type]) => type === ModelType.ACTION_PLANNER,
      )?.[1] as { tools: Array<{ name: string }> };
      expect(initial.tools.map(({ name }) => name)).toContain(
        "DISCOVER_ACTIONS",
      );
      expect(initial.tools.map(({ name }) => name)).not.toContain(
        "FETCH_EXAMPLE_PAGE",
      );
      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply")
        expect(result.result.responseContent?.text).toBe(
          "Both checks completed.",
        );
    },
  );
  it("resolves an unknown search hint instead of finishing with the Stage-1 acknowledgment", async () => {
    const acknowledgment = "Searching your stored messages now, read-only.";
    const answer = 'The original message says "green mug".';
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["memory"],
        intents: ["Search stored messages for the original mug color"],
        candidateActionNames: ["MEMORY_SEARCH_MESSAGES"],
        replyText: acknowledgment,
        extra: { replyEffectStatus: "none" },
      }),
      {
        text: "",
        toolCalls: [
          {
            id: "discover-memory",
            name: "DISCOVER_ACTIONS",
            arguments: {
              names: ["MEMORY_SEARCH"],
              eliza_turn_scope: "more_work_pending",
            },
          },
        ],
      },
      {
        text: "",
        toolCalls: [
          {
            id: "search-memory",
            name: "MEMORY_SEARCH",
            arguments: {
              query: "original mug color",
              eliza_turn_scope: "final",
            },
          },
        ],
      },
      JSON.stringify({
        decision: "FINISH",
        success: true,
        thought: "Original stored message retrieved.",
        messageToUser: answer,
      }),
    ]);
    const search = vi.fn(async () => ({
      success: true,
      text: 'Original message: "green mug".',
    }));
    runtime.actions = [
      {
        name: "MEMORY_SEARCH",
        similes: [],
        description: "Search stored messages.",
        contexts: ["memory"],
        parameters: [
          {
            name: "query",
            description: "Search query",
            required: true,
            schema: { type: "string" },
          },
        ],
        validate: async () => true,
        handler: search,
      },
    ] as never;
    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({
        text: "Search my stored messages for the original mug color. Quote the source. Keep my records and page unchanged.",
      }),
      state: {
        ...makeState(),
        values: { availableContexts: "general, memory" },
      },
      responseId: "00000000-0000-0000-0000-000000000009" as UUID,
    });
    expect(search).toHaveBeenCalledTimes(1);
    const calls = useModelCalls(runtime);
    expect(calls.map(([type]) => type)).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
      ModelType.ACTION_PLANNER,
      ModelType.RESPONSE_HANDLER,
    ]);
    const firstPlanner = calls[1][1] as { tools: Array<{ name: string }> };
    expect(firstPlanner.tools.map(({ name }) => name)).toContain(
      "DISCOVER_ACTIONS",
    );
    expect(firstPlanner.tools.map(({ name }) => name)).toContain(
      "MEMORY_SEARCH",
    );
    const afterDiscovery = calls[2][1] as { tools: Array<{ name: string }> };
    expect(
      afterDiscovery.tools.filter(({ name }) => name === "MEMORY_SEARCH"),
    ).toEqual(
      firstPlanner.tools.filter(({ name }) => name === "MEMORY_SEARCH"),
    );
    expect(
      afterDiscovery.tools.filter(({ name }) => name === "MEMORY_SEARCH"),
    ).toHaveLength(1);
    expect(result.kind).toBe("planned_reply");
    if (result.kind === "planned_reply")
      expect(result.result.responseContent?.text).toBe(answer);
  });

  it("delivers a complete general-context greeting without planning or domain schemas", async () => {
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["general"],
        intents: [],
        candidateActionNames: [],
        replyText: "Hey.",
        extra: { replyEffectStatus: "none" },
      }),
    ]);
    const handler = vi.fn(async () => ({
      success: true,
      text: "Unexpected domain work",
    }));
    runtime.actions = [
      {
        name: "CALENDAR",
        description: "Calendar domain schema sentinel",
        contexts: ["general"],
        similes: [],
        examples: [],
        validate: async () => true,
        handler,
      },
    ] as never;
    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "hi", channelType: ChannelType.DM }),
      responseId: "00000000-0000-0000-0000-000000000009" as UUID,
    });
    expect(handler).not.toHaveBeenCalled();
    const calls = useModelCalls(runtime);
    expect(calls.map(([type]) => type)).toEqual([ModelType.RESPONSE_HANDLER]);
    const handlerRequest = calls[0][1] as { tools: Array<{ name: string }> };
    expect(handlerRequest.tools.map((tool) => tool.name)).not.toContain(
      "CALENDAR",
    );
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply")
      expect(result.result.responseContent?.text).toBe("Hey.");
  });

  it.each([{ hints: [] }, { hints: ["MEMORY_SEARCH_MESSAGES"] }])(
    "discovers stored-message search for action hints $hints",
    async ({ hints }) => {
      const acknowledgment = "Searching your stored messages now, read-only.";
      const answer = 'The original message says "green mug".';
      const runtime = makeRuntime([
        stage1Response({
          contexts: ["memory"],
          intents: ["Search stored messages for the original mug color"],
          candidateActionNames: hints,
          replyText: acknowledgment,
          extra: { replyEffectStatus: "none" },
        }),
        {
          text: "",
          toolCalls: [
            {
              id: "discover-memory",
              name: "DISCOVER_ACTIONS",
              arguments: {
                names: ["MEMORY_SEARCH"],
                eliza_turn_scope: "more_work_pending",
              },
            },
          ],
        },
        {
          text: "",
          toolCalls: [
            {
              id: "search-memory",
              name: "MEMORY_SEARCH",
              arguments: {
                query: "original mug color",
                eliza_turn_scope: "final",
              },
            },
          ],
        },
        JSON.stringify({
          decision: "FINISH",
          success: true,
          thought: "Original stored message retrieved.",
          messageToUser: answer,
        }),
      ]);
      const search = vi.fn(async () => ({
        success: true,
        text: 'Original message: "green mug".',
      }));
      runtime.actions = [
        {
          name: "MEMORY_SEARCH",
          similes: [],
          description: "Search stored messages.",
          contexts: ["memory"],
          parameters: [
            {
              name: "query",
              description: "Search query",
              required: true,
              schema: { type: "string" },
            },
          ],
          validate: async () => true,
          handler: search,
        },
      ] as never;
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({
          channelType: ChannelType.DM,
          text: "Search my stored messages for the original mug color. Quote the source. Keep my records and page unchanged.",
        }),
        state: {
          ...makeState(),
          values: { availableContexts: "general, memory" },
        },
        responseId: "00000000-0000-0000-0000-000000000009" as UUID,
      });
      expect(search).toHaveBeenCalledTimes(1);
      const calls = useModelCalls(runtime);
      expect(calls.map(([type]) => type)).toEqual([
        ModelType.RESPONSE_HANDLER,
        ModelType.ACTION_PLANNER,
        ModelType.ACTION_PLANNER,
        ModelType.RESPONSE_HANDLER,
      ]);
      const firstPlanner = calls[1][1] as { tools: Array<{ name: string }> };
      expect(firstPlanner.tools.map(({ name }) => name)).toContain(
        "DISCOVER_ACTIONS",
      );
      expect(
        firstPlanner.tools.some(({ name }) => name === "MEMORY_SEARCH"),
      ).toBe(true);
      const afterDiscovery = calls[2][1] as { tools: Array<{ name: string }> };
      expect(
        afterDiscovery.tools.filter(({ name }) => name === "MEMORY_SEARCH"),
      ).toEqual(
        firstPlanner.tools.filter(({ name }) => name === "MEMORY_SEARCH"),
      );
      expect(
        afterDiscovery.tools.filter(({ name }) => name === "MEMORY_SEARCH"),
      ).toHaveLength(1);
      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply")
        expect(result.result.responseContent?.text).toBe(answer);
    },
  );

  it.each([false, true])(
    "preserves selected native children across family discovery and repeated operation reads with an initial child=%s",
    async (selectedChild) => {
      const answer = "Ledger entry created.";
      const discover = (id: string, names: string[]) => ({
        text: "",
        toolCalls: [
          {
            id,
            name: "DISCOVER_ACTIONS",
            arguments: {
              names,
              eliza_turn_scope: "more_work_pending",
            },
          },
        ],
      });
      const runtime = makeRuntime([
        stage1Response({
          contexts: ["general"],
          intents: ["record a ledger entry"],
          candidateActionNames: selectedChild
            ? ["CHECK_RUNTIME", "LEDGER_CREATE"]
            : ["CHECK_RUNTIME"],
          extra: { requiresTool: true },
        }),
        discover("discover-ledger", ["LEDGER"]),
        discover("rediscover-ledger-operations", [
          "LEDGER_CREATE",
          "LEDGER_DELETE",
        ]),
        discover("repeat-ledger-operations", [
          "LEDGER_CREATE",
          "LEDGER_DELETE",
        ]),
        {
          text: "",
          toolCalls: [
            {
              id: "create-entry",
              name: "LEDGER",
              arguments: {
                action: "create",
                id: "entry-1",
                eliza_turn_scope: "final",
              },
            },
          ],
        },
        JSON.stringify({
          decision: "FINISH",
          success: true,
          thought: "The ledger result is available.",
          messageToUser: answer,
        }),
      ]);
      const checkHandler = vi.fn<Action["handler"]>(async () => ({
        success: true,
        text: "Checked.",
      }));
      const ledgerHandler = vi.fn<Action["handler"]>(
        async (_runtime, _message, _state, options) => {
          expect(options?.parameters).toMatchObject({
            action: "create",
            id: "entry-1",
          });
          return { success: true, text: "Entry created." };
        },
      );
      const ledger: Action = {
        name: "LEDGER",
        description: "Create and remove ledger entries.",
        parameters: [
          {
            name: "action",
            description: "Operation",
            required: true,
            schema: { type: "string", enum: ["create", "delete"] },
          },
          {
            name: "id",
            description: "Entry identity",
            required: true,
            schema: { type: "string" },
          },
        ],
        examples: [],
        validate: async () => true,
        handler: ledgerHandler,
      };
      runtime.actions = [
        {
          name: "CHECK_RUNTIME",
          description: "Check the runtime without editing ledger entries.",
          contexts: ["general"],
          examples: [],
          validate: async () => true,
          handler: checkHandler,
        },
        ...promoteSubactionsToActions(ledger),
      ];
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({ text: "record a ledger entry for the lease" }),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000009" as UUID,
      });
      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply")
        expect(result.result.responseContent?.text).toBe(answer);
      expect(ledgerHandler).toHaveBeenCalledTimes(1);
      expect(checkHandler).not.toHaveBeenCalled();
      const calls = useModelCalls(runtime);
      expect(calls.map(([type]) => type)).toEqual([
        ModelType.RESPONSE_HANDLER,
        ModelType.ACTION_PLANNER,
        ModelType.ACTION_PLANNER,
        ModelType.ACTION_PLANNER,
        ModelType.ACTION_PLANNER,
        ModelType.RESPONSE_HANDLER,
      ]);
      const plannerTools = (index: number) =>
        (
          calls[index]?.[1] as
            | {
                tools?: Array<{
                  name: string;
                  description?: string;
                  parameters?: JSONSchema;
                }>;
              }
            | undefined
        )?.tools ?? [];
      const initial = plannerTools(1);
      const initialNames = initial.map(({ name }) => name);
      expect(initialNames).toContain("CHECK_RUNTIME");
      expect(initialNames).toContain("DISCOVER_ACTIONS");
      expect(initialNames.includes("LEDGER_CREATE")).toBe(selectedChild);
      expect(initialNames).not.toContain("LEDGER");
      const familyNames = (index: number) =>
        plannerTools(index)
          .filter(({ name }) => name.startsWith("LEDGER"))
          .map(({ name }) => name);
      // The model-facing tool projection is canonically name-ordered so
      // equal admitted sets keep an identical wire (cache) order.
      expect(familyNames(2)).toEqual(
        selectedChild ? ["LEDGER", "LEDGER_CREATE"] : ["LEDGER"],
      );
      const firstUmbrella = plannerTools(2).find(
        ({ name }) => name === "LEDGER",
      );
      expect(firstUmbrella?.description).toContain("LEDGER_DELETE");
      expect(
        firstUmbrella?.description?.includes('"name":"LEDGER_CREATE"'),
      ).toBe(!selectedChild);
      for (const index of [3, 4]) {
        expect(familyNames(index)).toEqual([
          "LEDGER",
          "LEDGER_CREATE",
          "LEDGER_DELETE",
        ]);
      }
      for (const index of [1, 2, 3, 4]) {
        const expanded = plannerTools(index);
        expect(expanded.find(({ name }) => name === "CHECK_RUNTIME")).toEqual(
          initial.find(({ name }) => name === "CHECK_RUNTIME"),
        );
        expect(expanded.map(({ name }) => name)).toContain("DISCOVER_ACTIONS");
        for (const tool of expanded.filter(({ name }) =>
          name.startsWith("LEDGER"),
        )) {
          const action = runtime.actions.find(
            (action) => action.name === tool.name,
          );
          if (!action || !tool.parameters)
            throw new Error("Missing ledger action schema");
          const schema = structuredClone(tool.parameters);
          expect(schema.properties?.eliza_turn_scope).toBeDefined();
          expect(schema.required).toContain("eliza_turn_scope");
          delete schema.properties?.eliza_turn_scope;
          schema.required = schema.required?.filter(
            (name) => name !== "eliza_turn_scope",
          );
          expect(schema).toEqual(normalizeActionJsonSchema(action));
          expect(schema.required).toContain("id");
          if (tool.name !== "LEDGER") {
            const pin = tool.name === "LEDGER_CREATE" ? "create" : "delete";
            expect(schema.properties?.action).toMatchObject({
              enum: [pin],
              default: pin,
            });
            expect(tool.description).not.toContain("Complete alias contracts:");
          }
        }
      }
      expect(plannerTools(4)).toEqual(plannerTools(3));
    },
  );

  it.each([
    { includeDomain: false, discoveryName: "DISCOVER_ACTIONS" },
    { includeDomain: true, discoveryName: "DISCOVER_ACTIONS" },
    { includeDomain: false, discoveryName: "DISCOVER_TOOLS" },
    { includeDomain: true, discoveryName: "DISCOVER_TOOLS" },
  ])(
    "retains canonical discovery for $discoveryName with domain selected=$includeDomain",
    async ({ includeDomain, discoveryName }) => {
      const runtime = makeRuntime([
        stage1Response({
          contexts: ["agent_internal"],
          candidateActionNames: includeDomain
            ? [discoveryName, "RUNTIME"]
            : [discoveryName],
          intents: ["inspect the RUNTIME schema"],
          extra: { requiresTool: true },
        }),
        {
          text: "",
          toolCalls: [
            {
              id: "catalog-1",
              name: discoveryName,
              arguments: { names: ["RUNTIME"], eliza_turn_scope: "final" },
            },
          ],
        },
        JSON.stringify({
          decision: "FINISH",
          success: true,
          thought: "Requested schema loaded.",
          messageToUser: "RUNTIME is available.",
        }),
      ]);
      const domainHandler = vi.fn(async () => ({
        success: true,
        text: "Domain action must not run.",
      }));
      runtime.actions = [
        {
          name: "RUNTIME",
          similes: [],
          description: "Inspect runtime state.",
          contexts: ["agent_internal"],
          parameters: [],
          validate: async () => true,
          handler: domainHandler,
        },
      ] as never;
      const result = await runStage1({
        runtime,
        message: makeMessage({
          text: `Use ${discoveryName} to inspect the RUNTIME schema. Do not run RUNTIME.`,
        }),
        responseId: "00000000-0000-0000-0000-000000000009" as UUID,
      });
      expect(result.kind).toBe("planned_reply");
      const calls = useModelCalls(runtime);
      expect(calls.map(([type]) => type)).toEqual([
        ModelType.RESPONSE_HANDLER,
        ModelType.ACTION_PLANNER,
        ModelType.RESPONSE_HANDLER,
      ]);
      const planner = calls[1][1] as { tools?: Array<{ name: string }> };
      expect(planner.tools?.map((tool) => tool.name)).toContain(
        "DISCOVER_ACTIONS",
      );
      expect(planner.tools?.map((tool) => tool.name)).not.toContain(
        "DISCOVER_TOOLS",
      );
      // Relevant contextual bootstrap may expose the domain before discovery;
      // exposing its schema still cannot execute it or replace discovery.
      expect(
        planner.tools?.filter((tool) => tool.name === "RUNTIME"),
      ).toHaveLength(1);
      expect(
        planner.tools?.filter((tool) => tool.name === "DISCOVER_ACTIONS"),
      ).toHaveLength(1);
      expect(domainHandler).not.toHaveBeenCalled();
      if (result.kind === "planned_reply")
        expect(result.result.responseContent?.text).toBe(
          "RUNTIME is available.",
        );
    },
  );
});
