/**
 * Real Core/Edge execution with deterministic HTTP boundaries; no provider traffic.
 * Budget: four mocked public HTTP GETs per cold weather read (GNIS, NWS point,
 * station collection, observation), zero duplicate public reads in canonical
 * execution. Real model dispatch is intercepted at HTTP; no paid requests.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AgentRuntime,
  ChannelType,
  type ModelParamsMap,
  type ModelResultMap,
  type UUID,
} from "@elizaos/core/edge";
import { resetKmsClientForTests } from "../../../db/crypto/kms-client";
import type { RuntimeR2Bucket } from "../../storage/r2-runtime-binding";
import type { RunSharedAgentTurnResult, SharedTurnMessage } from "./run-shared-agent-turn";
import { clearCurrentWeatherMetadataCacheForTests } from "./shared-current-weather";
import type { OwnerModelCapture } from "./shared-owner-model-capture";
import { createOwnerCaptureBuffer } from "./shared-owner-model-capture";
import {
  type OwnerCaptureBudgetStorage,
  readEncryptedOwnerCapture,
  reserveOwnerModelCapture,
} from "./shared-owner-model-capture-store";
import { SharedRuntimeTurnError } from "./shared-runtime-errors";
import { encodeSharedPublicWebGrounding } from "./shared-runtime-history-policy";

const SOURCE_URL = "https://api.weather.gov/stations/KSGF/observations/latest";
const CLAIM = "Springfield, Missouri is 69.8°F and Clear.";
const MARKED = `${CLAIM} [[SOURCE_URL:${SOURCE_URL}]]`;
const QUERY = "current public weather in Springfield, Missouri";
const USER_MESSAGE_ID = "35fa7289-3e70-4c0b-a64a-52fb8cc9a10d";
const PROMPT = "What is the current weather in Springfield, Missouri?";
const GENERAL_TOPIC = "Gmail API documentation rate limits";
const GENERAL_PROMPT = `Search the web for ${GENERAL_TOPIC}.`;
const GENERAL_SOURCE = "https://developers.google.com/gmail/api/reference/quotas";
const GENERAL_CLAIM =
  "The per-project quota is 1,200,000 units per minute; the per-user quota is 6,000 units per minute.";
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.CEREBRAS_API_KEY;
const ORIGINAL_FALLBACK_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ENVIRONMENT = process.env.ENVIRONMENT;
const ORIGINAL_KMS_BACKEND = process.env.ELIZA_KMS_BACKEND;
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8"));
const GNIS = fixture("usgs-springfield-mo-20261009.json");
const STATION = fixture("nws-ksgf-station-20261009.json");
const OBSERVATION = fixture("nws-ksgf-observation-20261009.json");
const POINT_URL = "https://api.weather.gov/points/37.2153,-93.2982";
const STATIONS_URL = "https://api.weather.gov/gridpoints/SGF/67,35/stations";
const GNIS_URL =
  "https://dashboard.waterdata.usgs.gov/service/geocoder/get/location/1.0?term=Springfield&include=gnis&states=MO&maxSuggestions=20";
let clock: ReturnType<typeof spyOn>;

beforeEach(() => {
  clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-09T02:16:00Z"));
  process.env.CEREBRAS_API_KEY = "offline-preflight-test-key";
  delete process.env.OPENROUTER_API_KEY;
  process.env.NODE_ENV = "production";
  process.env.ENVIRONMENT = "local";
  process.env.ELIZA_KMS_BACKEND = "memory";
  resetKmsClientForTests();
});
afterEach(() => {
  resetKmsClientForTests();
  if (ORIGINAL_ENVIRONMENT === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = ORIGINAL_ENVIRONMENT;
  if (ORIGINAL_KMS_BACKEND === undefined) delete process.env.ELIZA_KMS_BACKEND;
  else process.env.ELIZA_KMS_BACKEND = ORIGINAL_KMS_BACKEND;
  clock.mockRestore();
  clearCurrentWeatherMetadataCacheForTests();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.CEREBRAS_API_KEY;
  else process.env.CEREBRAS_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_FALLBACK_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_FALLBACK_KEY;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

type Mode = {
  messageIds?: { user: string; assistant: string };
  expectedPriorGrounding?: RunSharedAgentTurnResult["internalGrounding"];
  measureShape?: boolean;
  messaging?: boolean;
  sdkFailure?: boolean;
  general?: boolean;
  history?: SharedTurnMessage[];
  compound?: boolean;
  deny?: boolean;
  ordinary?: boolean;
  unavailable?: boolean;
  expectGroundingFailure?: boolean;
};
function modelResponse(content: string | null, calls: Array<{ name: string; args: object }> = []) {
  return Response.json({
    id: "offline-preflight",
    object: "chat.completion",
    created: 0,
    model: "qwen-3.8-27b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(calls.length
            ? {
                tool_calls: calls.map((call, index) => ({
                  id: `offline-tool-${index}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              }
            : {}),
        },
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  });
}

async function exercise(mode: Mode = {}, reply = MARKED, ownerCapture?: OwnerModelCapture) {
  clearCurrentWeatherMetadataCacheForTests();
  const messageIds = mode.messageIds ?? {
    user: USER_MESSAGE_ID,
    assistant: "3639b50e-f237-4b9a-99fa-75d890c1f97d",
  };
  const priorEncoded = mode.expectedPriorGrounding
    ? encodeSharedPublicWebGrounding(mode.expectedPriorGrounding)
    : undefined;
  const receiptCopies: Array<{
    ordinal: number;
    priorEncodedReceiptMessages: number;
    priorEncodedReceiptChars: number;
    freshActionReceiptMessages: number;
    freshActionReceiptChars: number;
    freshActionSourceObjectsMatchPrior: number;
  }> = [];
  let publicHttpCalls = 0;
  const participantNames: Array<string | undefined> = [];
  const publicHttpHops: string[] = [];
  let modelCalls = 0;
  let messagingStyleObserved = false;
  // Test-only numeric observers. Full strings exist only in RAM for exact
  // equality comparisons and are never returned, logged or hashed.
  const seenSegments = new Set<string>();
  const seenWireContent = new Set<string>();
  const coreShapes: Array<{
    modelType: string;
    messageChars: number;
    segments: Record<string, { count: number; chars: number; bytes: number }>;
    repeatedWithinBytes: number;
    repeatedEarlierCallBytes: number;
  }> = [];
  const wireShapes: Array<{
    ordinal: number;
    roles: Record<
      string,
      { count: number; messageJSONChars: number; contentChars: number; contentBytes: number }
    >;
    requestJSONChars: number;
    toolCount: number;
    toolJSONChars: number;
    toolSchemaJSONChars: number;
    responseFormatJSONChars: number;
    responseFormatSchemaJSONChars: number;
    toolDescriptionChars: number;
    repeatedWithinBytes: number;
    repeatedEarlierCallBytes: number;
  }> = [];
  const advertisedSdkTools: Array<Array<{ name: string; parameters: unknown }>> = [];
  let freeSelectionsBeforeAction = 0;
  let validations = 0;
  let otherActions = 0;
  let coreActionResults: Array<{ actionName: unknown; query: unknown; success: boolean }> = [];
  let legacyCacheCountAtStop: number | null = null;
  const modelChronology: Array<{ ordinal: number; phase: string; beforeAction: boolean }> = [];
  let registeredShortcut = false;
  const actions: Array<{ query: unknown; success: boolean }> = [];
  const restorers: Array<{ mockRestore(): void }> = [];
  const initialize = AgentRuntime.prototype.initialize;
  const initialization = spyOn(AgentRuntime.prototype, "initialize").mockImplementation(
    async function (this: AgentRuntime, options) {
      const result = await initialize.call(this, options);
      if (mode.measureShape) {
        const originalUseModel = this.useModel;
        restorers.push(
          spyOn(this, "useModel").mockImplementation(function <
            T extends keyof ModelParamsMap,
            R = ModelResultMap[T],
          >(this: AgentRuntime, type: T, params: ModelParamsMap[T], provider?: string): Promise<R> {
            const value = params as unknown as {
              messages?: Array<{ content?: unknown }>;
              promptSegments?: Array<{
                content?: unknown;
                id?: unknown;
                label?: unknown;
                stable?: unknown;
              }>;
            };
            const segments: Record<string, { count: number; chars: number; bytes: number }> = {};
            const current = new Set<string>();
            let repeatedWithinBytes = 0,
              repeatedEarlierCallBytes = 0;
            for (const segment of value.promptSegments ?? []) {
              if (typeof segment.content !== "string") continue;
              const text = segment.content;
              const label = typeof segment.label === "string" ? segment.label : "";
              const category =
                segment.id === "system"
                  ? "persona_system"
                  : segment.id === "character-style"
                    ? "character_style"
                    : label.startsWith("provider:")
                      ? "providers"
                      : label.startsWith("prior_message:")
                        ? "prior_dialogue"
                        : text.trimStart().startsWith("message_handler_stage:") ||
                            text.trimStart().startsWith("planner_stage:")
                          ? "stage_instructions"
                          : label === "message:user"
                            ? "current_message"
                            : "other";
              const bucket = `${segment.stable === true ? "stable" : "dynamic"}_${category}`;
              const measure = (segments[bucket] ??= { count: 0, chars: 0, bytes: 0 });
              measure.count++;
              measure.chars += text.length;
              measure.bytes += new TextEncoder().encode(text).length;
              if (text.length >= 128 && current.has(text))
                repeatedWithinBytes += new TextEncoder().encode(text).length;
              if (text.length >= 128 && seenSegments.has(text))
                repeatedEarlierCallBytes += new TextEncoder().encode(text).length;
              current.add(text);
            }
            for (const text of current) seenSegments.add(text);
            coreShapes.push({
              modelType: [
                "RESPONSE_HANDLER",
                "ACTION_PLANNER",
                "TEXT_SMALL",
                "TEXT_LARGE",
              ].includes(String(type))
                ? String(type)
                : "other",
              messageChars: (value.messages ?? []).reduce(
                (n, message) =>
                  n +
                  (typeof message.content === "string"
                    ? message.content.length
                    : JSON.stringify(message.content ?? null).length),
                0,
              ),
              segments,
              repeatedWithinBytes,
              repeatedEarlierCallBytes,
            });
            return originalUseModel.call(this, type, params, provider) as Promise<R>;
          }),
        );
      }
      const service = this.messageService;
      if (!service) throw new Error("Actual Core message service unavailable after initialization");
      const handleMessage = service.handleMessage;
      restorers.push(
        spyOn(service, "handleMessage").mockImplementation(async (...args) => {
          const processed = await handleMessage.apply(service, args);
          coreActionResults = (processed.actionResults ?? []).map((actionResult) => ({
            actionName: actionResult.data?.actionName,
            query: actionResult.data?.query,
            success: actionResult.success,
          }));
          return processed;
        }),
      );
      registeredShortcut ||= this.responseHandlerEvaluators.some(
        (evaluator) => evaluator.name === "shared.verified_public_preflight",
      );
      const action = this.actions.find((candidate) => candidate.name === "WEB_SEARCH");
      if (action) {
        const handler = action.handler;
        const validate = action.validate;
        restorers.push(
          spyOn(action, "validate").mockImplementation(async (...args) => {
            validations += 1;
            return mode.deny ? false : await validate(...args);
          }),
        );
        restorers.push(
          spyOn(action, "handler").mockImplementation(async (...args) => {
            const options = args[3] as
              | { parameters?: { query?: unknown }; query?: unknown }
              | undefined;
            const query = options?.parameters?.query ?? options?.query;
            const result = await handler(...args);
            actions.push({
              query,
              success: Boolean(
                result && typeof result === "object" && "success" in result && result.success,
              ),
            });
            return result;
          }),
        );
      }
      if (mode.compound) {
        this.registerAction({
          name: "OTHER_ACTION",
          description: "Perform the other requested operation.",
          tags: ["capability:write"],
          contexts: ["general"],
          roleGate: { minRole: "USER" },
          parameters: [],
          validate: async () => true,
          handler: async () => {
            otherActions += 1;
            return {
              success: true,
              text: "Other operation completed.",
              data: { actionName: "OTHER_ACTION", done: true },
            };
          },
        });
      }
      return result;
    },
  );
  const stop = AgentRuntime.prototype.stop;
  const stopping = spyOn(AgentRuntime.prototype, "stop").mockImplementation(async function (
    this: AgentRuntime,
    ...args
  ) {
    legacyCacheCountAtStop = this.getActionResults(messageIds.user as UUID).length;
    return await stop.apply(this, args);
  });
  const ensureConnection = AgentRuntime.prototype.ensureConnection;
  const connecting = spyOn(AgentRuntime.prototype, "ensureConnection").mockImplementation(
    async function (this: AgentRuntime, ...args) {
      participantNames.push(args[0].userName);
      return await ensureConnection.apply(this, args);
    },
  );
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = url instanceof Request ? url.url : String(url);
    const body =
      init?.body === undefined && url instanceof Request
        ? await url.clone().text()
        : String(init?.body ?? "");
    if (mode.general && target === "https://search.parallel.ai/mcp") {
      publicHttpCalls += 1;
      publicHttpHops.push(target);
      expect(publicHttpCalls).toBe(1);
      expect(actions).toHaveLength(0);
      expect(JSON.parse(body).params.arguments).toEqual({
        objective: GENERAL_TOPIC,
        search_queries: [GENERAL_TOPIC],
      });
      expect(body).not.toContain("Springfield");
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [
                  { url: GENERAL_SOURCE, title: "Gmail API quotas", excerpt: GENERAL_CLAIM },
                ],
              }),
            },
          ],
        },
      });
    }
    if ([GNIS_URL, POINT_URL, STATIONS_URL, SOURCE_URL].includes(target)) {
      publicHttpCalls += 1;
      publicHttpHops.push(target);
      if (publicHttpCalls > 4 || publicHttpHops.filter((hop) => hop === target).length > 1) {
        throw new Error("Duplicate public HTTP exceeded the offline cold-read budget");
      }
      expect(init?.redirect).toBe("error");
      let payload: unknown;
      if (target === GNIS_URL) payload = GNIS;
      else if (target === POINT_URL) {
        // Point route/geometry matches retained actual hop receipt; body is a
        // minimal synthetic transport fixture, not a retained raw point body.
        payload = {
          geometry: { type: "Point", coordinates: [-93.2982, 37.2153] },
          properties: { observationStations: STATIONS_URL },
        };
      } else if (target === STATIONS_URL) payload = { features: [STATION] };
      else {
        payload = structuredClone(OBSERVATION);
        if (mode.unavailable) (payload as typeof OBSERVATION).properties.temperature.value = null;
      }
      return Response.json(payload);
    }
    if (target !== "https://api.cerebras.ai/v1/chat/completions") {
      throw new Error("Unexpected network boundary in offline Core test");
    }
    if (mode.sdkFailure) {
      modelCalls += 1;
      return Response.json(
        { error: { message: "SYNTHETIC_PRIVATE_PROVIDER_ERROR", type: "server_error" } },
        { status: 502 },
      );
    }
    const request = JSON.parse(body) as {
      tools?: Array<{ function?: { name?: string; parameters?: unknown } }>;
      messages?: Array<Record<string, unknown>>;
      response_format?: { json_schema?: { schema?: unknown } };
    };
    modelCalls += 1;
    if (mode.measureShape) {
      const roles: Record<
        string,
        { count: number; messageJSONChars: number; contentChars: number; contentBytes: number }
      > = {};
      const current = new Set<string>();
      let repeatedWithinBytes = 0,
        repeatedEarlierCallBytes = 0;
      for (const message of request.messages ?? []) {
        const role = ["system", "user", "assistant", "tool"].includes(String(message.role))
          ? String(message.role)
          : "other";
        const content =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? null);
        const row = (roles[role] ??= {
          count: 0,
          messageJSONChars: 0,
          contentChars: 0,
          contentBytes: 0,
        });
        row.count++;
        row.messageJSONChars += JSON.stringify(message).length;
        row.contentChars += content.length;
        row.contentBytes += new TextEncoder().encode(content).length;
        if (content.length >= 128 && current.has(content))
          repeatedWithinBytes += new TextEncoder().encode(content).length;
        if (content.length >= 128 && seenWireContent.has(content))
          repeatedEarlierCallBytes += new TextEncoder().encode(content).length;
        current.add(content);
      }
      for (const text of current) seenWireContent.add(text);
      const tools = request.tools as
        | Array<{ function?: { parameters?: unknown; description?: unknown } }>
        | undefined;
      wireShapes.push({
        ordinal: modelCalls,
        roles,
        requestJSONChars: body.length,
        toolCount: tools?.length ?? 0,
        toolJSONChars: JSON.stringify(tools ?? []).length,
        responseFormatJSONChars:
          request.response_format === undefined
            ? 0
            : JSON.stringify(request.response_format).length,
        responseFormatSchemaJSONChars:
          request.response_format?.json_schema?.schema === undefined
            ? 0
            : JSON.stringify(request.response_format.json_schema.schema).length,
        toolSchemaJSONChars: (tools ?? []).reduce(
          (n, tool) => n + JSON.stringify(tool.function?.parameters ?? null).length,
          0,
        ),
        toolDescriptionChars: (tools ?? []).reduce(
          (n, tool) =>
            n +
            (typeof tool.function?.description === "string" ? tool.function.description.length : 0),
          0,
        ),
        repeatedWithinBytes,
        repeatedEarlierCallBytes,
      });
    }
    if (priorEncoded) {
      let priorEncodedReceiptMessages = 0,
        freshActionReceiptMessages = 0,
        freshActionReceiptChars = 0,
        freshActionSourceObjectsMatchPrior = 0;
      for (const message of request.messages ?? []) {
        if (typeof message.content !== "string") continue;
        if (message.content.includes(priorEncoded)) priorEncodedReceiptMessages += 1;
        if (message.role !== "tool") continue;
        let value: unknown;
        try {
          value = JSON.parse(message.content);
        } catch {
          continue;
        }
        const result = value as {
          success?: unknown;
          data?: { actionName?: unknown; query?: unknown; sources?: unknown };
        } | null;
        if (
          result?.success === true &&
          result.data?.actionName === "WEB_SEARCH" &&
          result.data.query === GENERAL_TOPIC
        ) {
          freshActionReceiptMessages += 1;
          freshActionReceiptChars += message.content.length;
          if (
            mode.expectedPriorGrounding?.kind === "web_search" &&
            JSON.stringify(result.data.sources) ===
              JSON.stringify(mode.expectedPriorGrounding.sources)
          )
            freshActionSourceObjectsMatchPrior += 1;
        }
      }
      receiptCopies.push({
        ordinal: modelCalls,
        priorEncodedReceiptMessages,
        priorEncodedReceiptChars: priorEncoded.length,
        freshActionReceiptMessages,
        freshActionReceiptChars,
        freshActionSourceObjectsMatchPrior,
      });
    }
    if (modelCalls > 12) throw new Error("Offline model-dispatch count bound exceeded");
    const names = request.tools?.map((tool) => tool.function?.name) ?? [];
    advertisedSdkTools.push(
      (request.tools ?? []).flatMap((tool) =>
        typeof tool.function?.name === "string"
          ? [{ name: tool.function.name, parameters: tool.function.parameters }]
          : [],
      ),
    );
    const system = (request.messages ?? [])
      .filter((message) => message.role === "system" && typeof message.content === "string")
      .map((message) => message.content as string)
      .join("\n");
    messagingStyleObserved ||=
      system.includes("Messaging reply style:") && system.includes("conversational plain text");
    const signals = [
      ...(names.includes("HANDLE_RESPONSE") ? ["stage1"] : []),
      ...(names.includes("FACTS_AND_RELATIONSHIPS_VALIDATE") ? ["facts"] : []),
      ...(/(?:^|\n)planner_stage:\n/.test(system) ? ["planner"] : []),
      ...(/(?:^|\n)evaluator_stage:\n/.test(system) ? ["evaluator"] : []),
    ];
    const phase =
      signals.length === 1
        ? (signals[0] ?? "ambiguous")
        : signals.length === 0
          ? "other"
          : "ambiguous";
    modelChronology.push({
      ordinal: modelCalls,
      phase,
      beforeAction: actions.length === 0 && otherActions === 0,
    });
    if (phase === "ambiguous") throw new Error("Ambiguous offline model-stage signals");
    if (phase === "stage1") {
      return modelResponse(null, [
        {
          name: "HANDLE_RESPONSE",
          args: {
            shouldRespond: "RESPOND",
            thought: "Use the current authorized operation.",
            contexts: mode.general ? ["web"] : mode.ordinary ? ["simple"] : ["general"],
            intents: mode.compound ? ["current weather", "other operation"] : [],
            candidateActionNames: mode.ordinary
              ? []
              : mode.compound
                ? ["WEB_SEARCH", "OTHER_ACTION"]
                : ["WEB_SEARCH"],
            requiresTool: !mode.ordinary,
            replyText: mode.ordinary ? "Hello! Happy to help." : "",
            replyEffectStatus: "none",
            facts: [],
            relationships: [],
            addressedTo: [],
          },
        },
      ]);
    }
    if (phase === "facts") {
      return modelResponse(null, [
        {
          name: "FACTS_AND_RELATIONSHIPS_VALIDATE",
          args: { facts: [], relationships: [], thought: "No additional facts." },
        },
      ]);
    }
    if (phase === "evaluator") {
      if (mode.compound && otherActions === 0) {
        return modelResponse(
          JSON.stringify({
            success: false,
            decision: "CONTINUE",
            thought: "The other requested operation is still pending.",
          }),
        );
      }
      return modelResponse(
        JSON.stringify({
          success: !mode.deny,
          decision: "FINISH",
          thought: "All requested operations are settled.",
          messageToUser: mode.deny ? "The requested operation was denied." : reply,
        }),
      );
    }
    if (phase === "planner") {
      if (names.includes("WEB_SEARCH") && actions.length === 0 && !mode.deny) {
        freeSelectionsBeforeAction += 1;
        return modelResponse(null, [
          {
            name: "WEB_SEARCH",
            args: {
              ...(mode.general ? {} : { query: QUERY }),
              eliza_turn_scope: mode.compound ? "more_work_pending" : "final",
            },
          },
        ]);
      }
      if (mode.compound && actions.length > 0 && otherActions === 0) {
        if (!names.includes("OTHER_ACTION"))
          throw new Error("Compound action disappeared from the authorized planner surface");
        return modelResponse(null, [{ name: "OTHER_ACTION", args: { eliza_turn_scope: "final" } }]);
      }
      const text = mode.deny ? "The requested operation was denied." : reply;
      return names.includes("REPLY")
        ? modelResponse(null, [{ name: "REPLY", args: { text, eliza_turn_scope: "final" } }])
        : modelResponse(
            JSON.stringify({
              thought: "Return the settled answer.",
              toolCalls: [],
              completed: true,
              messageToUser: text,
            }),
          );
    }
    return modelResponse(mode.deny ? "The requested operation was denied." : reply);
  }) as typeof fetch;
  let result: RunSharedAgentTurnResult | undefined;
  let failed = false;
  let failureCategory:
    | "sdk_failure"
    | "canonical_action_denied"
    | "canonical_search_unavailable"
    | "reply_grounding_failed"
    | undefined;
  try {
    const { runSharedAgentTurn } = await import("./run-shared-agent-turn");
    result = await runSharedAgentTurn({
      ownerCapture,
      character: { name: "Shared Eliza", system: "You are Eliza.", model: "qwen-3.8-27b" },
      history: mode.history ?? [],
      message: mode.general
        ? GENERAL_PROMPT
        : mode.ordinary
          ? "Hello there"
          : mode.compound
            ? `${PROMPT} Also perform the other operation.`
            : PROMPT,
      ...(mode.ordinary
        ? {}
        : {
            capabilityText: mode.general
              ? GENERAL_PROMPT
              : mode.compound
                ? `${PROMPT} Also perform the other operation.`
                : PROMPT,
          }),
      messageIds,
      execution: {
        channel: { type: ChannelType.DM, source: mode.messaging ? "blooio" : "shared-runtime" },
        authenticatedPersonalSharedUser: true,
        participantName: "QA Owner",
        agentKey: "personal:b55d99d0-ae38-4c7c-8791-7443e5de8ebc",
        roomKey: "offline-preflight-room",
      },
    });
  } catch (error) {
    if (!(error instanceof SharedRuntimeTurnError)) throw error;
    const kinds: unknown[] = [];
    const codes: unknown[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
      const record = current as {
        code?: unknown;
        kind?: unknown;
        context?: { failureKind?: unknown };
        cause?: unknown;
      };
      kinds.push(record.kind, record.context?.failureKind);
      codes.push(record.code);
      current = record.cause;
    }
    if (mode.sdkFailure) {
      failureCategory = "sdk_failure";
    } else if (
      mode.expectGroundingFailure &&
      codes.includes("REPLY_GROUNDING_FAILED") &&
      actions.length === 1 &&
      actions[0]?.success
    ) {
      failureCategory = "reply_grounding_failed";
    } else if (
      mode.deny &&
      validations > 0 &&
      actions.length === 0 &&
      kinds.includes("missing_capability")
    ) {
      failureCategory = "canonical_action_denied";
    } else if (
      mode.deny &&
      validations > 0 &&
      actions.length === 0 &&
      result === undefined &&
      codes.includes("REPLY_GROUNDING_FAILED")
    ) {
      failureCategory = "canonical_action_denied";
    } else if (
      mode.unavailable &&
      actions.length > 0 &&
      actions.every((action) => !action.success) &&
      kinds.some(
        (kind) =>
          kind === "handler_error" ||
          kind === "missing_capability" ||
          kind === "planner_exhaustion",
      )
    ) {
      failureCategory = "canonical_search_unavailable";
    } else {
      throw error;
    }
    failed = true;
  } finally {
    initialization.mockRestore();
    stopping.mockRestore();
    connecting.mockRestore();
    for (const spy of restorers) spy.mockRestore();
    seenSegments.clear();
    seenWireContent.clear();
  }
  console.info("[offline-preflight-chronology]", {
    mode: {
      compound: !!mode.compound,
      deny: !!mode.deny,
      ordinary: !!mode.ordinary,
      unavailable: !!mode.unavailable,
      unsupported: !!mode.expectGroundingFailure,
    },
    publicHttpCalls,
    publicHttpHops,
    modelCalls,
    modelChronology,
    legacyCacheCountAtStop,
    coreResultCount: coreActionResults.length,
    failed,
    failureCategory: failureCategory ?? null,
  });
  return {
    messagingStyleObserved,
    receiptCopies,
    coreShapes,
    wireShapes,
    advertisedSdkTools,
    participantNames,
    result,
    failed,
    failureCategory,
    publicHttpCalls,
    publicHttpHops,
    modelCalls,
    modelChronology,
    freeSelectionsBeforeAction,
    validations,
    otherActions,
    actions,
    coreActionResults,
    legacyCacheCountAtStop,
    registeredShortcut,
  };
}

const CAPTURE_SCOPE = {
  organizationId: "11111111-1111-4111-a111-111111111111",
  userId: "22222222-2222-4222-a222-222222222222",
  roomId: "33333333-3333-4333-a333-333333333333",
  traceId: "a".repeat(32),
};
function privateCaptureBoundary() {
  const rows = new Map<string, unknown>();
  const ciphertext = new Map<string, string>();
  const pending: Promise<unknown>[] = [];
  const storage: OwnerCaptureBudgetStorage = {
    async transaction<T>(fn: Parameters<OwnerCaptureBudgetStorage["transaction"]>[0]): Promise<T> {
      return (await fn({
        get: async <V>(key: string) => structuredClone(rows.get(key)) as V | undefined,
        put: async <V>(key: string, value: V) => {
          rows.set(key, structuredClone(value));
        },
      })) as T;
    },
  };
  const bucket: RuntimeR2Bucket = {
    async get(key) {
      const value = ciphertext.get(key);
      return value === undefined
        ? null
        : {
            size: new TextEncoder().encode(value).byteLength,
            body: new Response(value).body!,
            text: async () => value,
          };
    },
    async put(key, value, options) {
      expect(options?.onlyIf).toEqual({ etagDoesNotMatch: "*" });
      if (typeof value !== "string" || ciphertext.has(key))
        throw new Error("Synthetic immutable R2 boundary rejected");
      ciphertext.set(key, value);
      return { version: "synthetic-private-version" };
    },
    async delete(key) {
      ciphertext.delete(key);
    },
  };
  const now = Date.now();
  const policy = {
    version: 1,
    sessionId: "44444444-4444-4444-a444-444444444444",
    organizationId: CAPTURE_SCOPE.organizationId,
    userId: CAPTURE_SCOPE.userId,
    readerUserId: CAPTURE_SCOPE.userId,
    roomId: CAPTURE_SCOPE.roomId,
    issuedAt: now - 1,
    expiresAt: now + 60_000,
    retainUntil: now + 86_000_000,
    maxTurns: 1,
    maxCalls: 32,
    maxBytes: 4 * 1024 * 1024,
  };
  return { storage, bucket, ciphertext, pending, policy };
}

test("genuine preflight enters canonical execution without free-query selection", async () => {
  expect(AgentRuntime.ownerToolExecutionObserverVersion).toBe(1);
  const boundary = privateCaptureBoundary();
  const admitted = await reserveOwnerModelCapture({
    policyValue: JSON.stringify(boundary.policy),
    verifiedPersonalShared: true,
    scope: CAPTURE_SCOPE,
    storage: boundary.storage,
    bucket: boundary.bucket,
    waitUntil: (work) => {
      boundary.pending.push(work);
    },
  });
  expect(admitted.state).toBe("admitted");
  const actual = await exercise({}, MARKED, admitted.capture);
  admitted.capture!.finish({
    boundary: "offline-cloud-response-ready",
    reply: actual.result?.reply,
    responded: actual.result?.responded,
  });
  await Promise.all(boundary.pending);
  expect(admitted.persistence.state).toBe("stored");
  const readback = await readEncryptedOwnerCapture({
    storage: boundary.storage,
    bucket: boundary.bucket,
    locator: admitted.locator!,
    principal: { ...CAPTURE_SCOPE, authenticatedOwner: true },
    roomId: CAPTURE_SCOPE.roomId,
  });
  expect(readback.objectAuthenticated).toBe(true);
  const capture = readback.payload!;
  expect(capture.coverage.actionArguments).toBe("canonical-observer");
  expect(capture.coverage.callsObserved).toBe(actual.modelCalls);
  expect(capture.coverage.pendingCalls).toBe(0);
  expect(capture.coverage.pendingTimings).toBe(0);
  expect(capture.coverage.toolExecutionsStarted).toBeGreaterThan(0);
  expect(capture.coverage.toolExecutionsSettled).toBe(capture.coverage.toolExecutionsStarted);
  expect(capture.coverage.pendingToolExecutions).toBe(0);
  expect(capture.usageCoverage.state).toBe("complete");
  const requests = capture.events.filter((event) => event.kind === "sdk-request");
  expect(requests.length).toBe(actual.modelCalls);
  expect(JSON.stringify(requests)).toContain(PROMPT);
  expect(JSON.stringify(requests)).toContain("WEB_SEARCH");
  const sdkInputs = requests.map(
    (event) =>
      (event.payload as { input: { tools?: Array<{ name: string; inputSchema?: unknown }> } })
        .input,
  );
  expect(sdkInputs.length).toBe(actual.advertisedSdkTools.length);
  for (const [index, input] of sdkInputs.entries()) {
    const advertised = actual.advertisedSdkTools[index] ?? [];
    expect(input.tools?.map((tool) => tool.name) ?? []).toEqual(
      advertised.map((tool) => tool.name),
    );
    for (const [toolIndex, tool] of (input.tools ?? []).entries()) {
      expect(
        tool.inputSchema !== null &&
          typeof tool.inputSchema === "object" &&
          !Array.isArray(tool.inputSchema),
      ).toBe(true);
      expect(tool.inputSchema).toEqual(advertised[toolIndex]?.parameters);
    }
  }
  expect(JSON.stringify(capture.events)).not.toContain("offline-preflight-test-key");
  expect([...boundary.ciphertext.values()].join("")).not.toContain(PROMPT);
  const starts = capture.events
    .filter((event) => event.kind === "action-started")
    .map((event) => event.payload as { executionId: string; args: unknown });
  const settled = capture.events
    .filter((event) => event.kind === "action-completed")
    .map((event) => event.payload as { executionId: string; result: unknown });
  expect(
    starts.every((started) =>
      settled.some((terminal) => terminal.executionId === started.executionId),
    ),
  ).toBe(true);
  expect(JSON.stringify(starts)).toContain(QUERY);
  expect(JSON.stringify(settled)).toContain(SOURCE_URL);
  expect(actual.participantNames).toContain("QA Owner");
  expect(actual.participantNames).not.toContain("Shared user");
  expect(actual.registeredShortcut).toBe(true);
  expect(actual.publicHttpCalls).toBe(4);
  expect(actual.publicHttpHops).toEqual([GNIS_URL, POINT_URL, STATIONS_URL, SOURCE_URL]);
  expect(actual.freeSelectionsBeforeAction).toBe(0);
  expect(actual.actions).toEqual([{ query: QUERY, success: true }]);
  expect(actual.coreActionResults).toEqual([
    { actionName: "WEB_SEARCH", query: QUERY, success: true },
  ]);
  expect(actual.legacyCacheCountAtStop).not.toBeNull();
  expect(actual.result?.reply).toStartWith(CLAIM);
  expect(
    actual.result?.actionResults?.filter((result) => result.data?.actionName === "WEB_SEARCH"),
  ).toHaveLength(1);
});

test("canonical denial and unsupported source claims retain their gates", async () => {
  const unsupported = await exercise(
    { expectGroundingFailure: true },
    `Springfield, Missouri is 69.8°C and Clear. [[SOURCE_URL:${SOURCE_URL}]]`,
  );
  expect(unsupported.publicHttpCalls).toBe(4);
  expect(unsupported.actions).toEqual([{ query: QUERY, success: true }]);
  if (unsupported.failed) {
    expect(unsupported.failureCategory).toBe("reply_grounding_failed");
    expect(unsupported.result).toBeUndefined();
  } else {
    const grounding = unsupported.result?.internalGrounding;
    if (!grounding || grounding.kind !== "web_search") {
      throw new Error("Unsupported claim returned without the genuine current grounding");
    }
    expect(unsupported.result?.reply).toBe(
      "I couldn’t verify an answer from the sources I found. Please try rephrasing your question.",
    );
    expect(unsupported.result?.reply).not.toContain("69.8°C");
  }
  const denialCapture = createOwnerCaptureBuffer(
    CAPTURE_SCOPE,
    { maxCalls: 32, maxBytes: 4 * 1024 * 1024, expiresAt: Date.now() + 60_000 },
    () => {},
  );
  let observedGateCount = 0;
  const throwingObserver: OwnerModelCapture = {
    ...denialCapture,
    async canonicalTool(event) {
      denialCapture.canonicalTool(event);
      if (event.phase === "gate") observedGateCount += 1;
      denialCapture.omission();
      throw new Error("Synthetic asynchronous owner observer refusal");
    },
  };
  const denied = await exercise({ deny: true }, MARKED, throwingObserver);
  await Promise.resolve();
  expect(observedGateCount).toBeGreaterThan(0);
  expect(denialCapture.snapshot().coverage.toolExecutionsStarted).toBe(0);
  expect(denialCapture.snapshot().coverage.pendingToolExecutions).toBe(0);
  expect(denialCapture.snapshot().coverage.exactFull).toBe(false);
  expect(denied.validations).toBeGreaterThan(0);
  expect(denied.actions).toHaveLength(0);
  expect(denied.publicHttpCalls).toBe(4);
  if (denied.failed) {
    expect(denied.failureCategory).toBe("canonical_action_denied");
  } else {
    expect(denied.result?.reply).toMatch(/couldn’t verify|couldn’t check|denied/i);
  }
});

test("compound work remains planner-owned and retains the other action", async () => {
  const actual = await exercise({ compound: true });
  expect(actual.freeSelectionsBeforeAction).toBeGreaterThan(0);
  expect(actual.actions).toHaveLength(1);
  expect(actual.otherActions).toBe(1);
  expect(actual.publicHttpCalls).toBe(4);
  expect(
    actual.result?.actionResults?.some((result) => result.data?.actionName === "OTHER_ACTION"),
  ).toBe(true);
});

test("ordinary chat and unavailable preflight keep their existing paths", async () => {
  const ordinary = await exercise({ ordinary: true });
  expect(ordinary.registeredShortcut).toBe(false);
  expect(ordinary.publicHttpCalls).toBe(0);
  expect(ordinary.modelCalls).toBe(1);
  expect(ordinary.result?.reply).toBe("Hello! Happy to help.");
  const unavailable = await exercise({ unavailable: true });
  expect(unavailable.registeredShortcut).toBe(false);
  expect(unavailable.publicHttpCalls).toBe(4);
  expect(unavailable.actions).toEqual([{ query: QUERY, success: false }]);
  if (unavailable.failed) {
    expect(unavailable.failureCategory).toBe("canonical_search_unavailable");
  } else {
    expect(unavailable.result?.reply).toContain("couldn’t check");
  }
});

test("general Gmail documentation uses canonical query and source footer after real weather history", async () => {
  const prior = await exercise({ measureShape: true });
  expect(prior.result?.internalGrounding?.kind).toBe("web_search");
  if (!prior.result) throw new Error("Actual weather history was not produced");
  const paraphrase =
    "Each project can use 1.2 million quota units per minute, and each user can use 6k quota units per minute.";
  const actual = await exercise(
    { general: true, messaging: true, measureShape: true, history: prior.result.history },
    `${paraphrase} [[SOURCE_URL:${GENERAL_SOURCE}]]`,
  );
  expect(actual.failed).toBe(false);
  expect(actual.publicHttpCalls).toBe(1);
  expect(actual.actions).toEqual([{ query: GENERAL_TOPIC, success: true }]);
  expect(actual.freeSelectionsBeforeAction).toBe(0);
  expect(actual.coreActionResults).toContainEqual({
    actionName: "WEB_SEARCH",
    query: GENERAL_TOPIC,
    success: true,
  });
  expect(actual.result?.reply).toContain(paraphrase);
  expect(actual.result?.reply).toContain(`Source: ${GENERAL_SOURCE}`);
  expect(actual.messagingStyleObserved).toBe(true);
  expect(actual.result?.reply).not.toContain("SOURCE_URL:");
  expect(actual.result?.reply).not.toContain("Springfield");
  expect(actual.coreShapes).toHaveLength(actual.modelCalls);
  expect(actual.wireShapes).toHaveLength(actual.modelCalls);
  expect(
    actual.coreShapes.some((row) =>
      Object.keys(row.segments).some((key) => key.endsWith("stage_instructions")),
    ),
  ).toBe(true);
  // Structured output can use response_format instead of tool definitions.
  expect(actual.wireShapes.every((row) => row.requestJSONChars > 0)).toBe(true);
  expect(
    actual.wireShapes.some((row) => row.toolCount > 0 || row.responseFormatSchemaJSONChars > 0),
  ).toBe(true);
  const summary = {
    minimumComparedChars: 128,
    weather: { core: prior.coreShapes, wire: prior.wireShapes },
    general: { core: actual.coreShapes, wire: actual.wireShapes },
  };
  const pending: unknown[] = [summary];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string")
      expect(["RESPONSE_HANDLER", "ACTION_PLANNER", "TEXT_SMALL", "TEXT_LARGE", "other"]).toContain(
        value,
      );
    else if (typeof value === "number") expect(Number.isFinite(value) && value >= 0).toBe(true);
    else if (value && typeof value === "object") pending.push(...Object.values(value));
    else throw new Error("Numeric request-shape projection contains an unexpected leaf");
  }
  const encoded = JSON.stringify(summary);
  for (const privateValue of [
    GENERAL_TOPIC,
    GENERAL_SOURCE,
    PROMPT,
    USER_MESSAGE_ID,
    "offline-preflight-test-key",
    "QA Owner",
    "thought",
    "parameters",
  ])
    expect(encoded).not.toContain(privateValue);
  console.info("[offline-request-shape-numeric]", JSON.stringify(summary));
});

test("numeric model audit records actual SDK usage and failures without content", async () => {
  type Audit = {
    outcome: string;
    callCount: number;
    omittedCallCount: number;
    calls: Array<{
      modelType: string;
      purpose: string;
      outcome: string;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
    }>;
  };
  const audits: Audit[] = [];
  const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    if (args[0] === "[shared-eliza-runtime] model usage") audits.push(args[1] as Audit);
  });
  try {
    const success = await exercise({ ordinary: true }, "Hello.");
    expect(success.failed).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe("success");
    expect(audits[0].callCount).toBeGreaterThan(0);
    expect(audits[0].omittedCallCount).toBe(0);
    expect(
      audits[0].calls.every(
        (call) =>
          call.inputTokens === 8 &&
          call.outputTokens === 4 &&
          call.totalTokens === 12 &&
          call.outcome === "sdk_completed",
      ),
    ).toBe(true);
    expect(audits[0].calls.every((call) => call.modelType !== "unknown")).toBe(true);
    const failure = await exercise({ ordinary: true, sdkFailure: true });
    expect(failure.failed).toBe(true);
    expect(audits).toHaveLength(2);
    expect(audits[1].outcome).toBe("error");
    expect(audits[1].calls.length).toBeGreaterThan(0);
    expect(
      audits[1].calls.every(
        (call) =>
          call.outcome === "sdk_error" &&
          call.inputTokens === null &&
          call.outputTokens === null &&
          call.totalTokens === null,
      ),
    ).toBe(true);
    const encoded = JSON.stringify(audits);
    for (const content of [
      "Hello there",
      "SYNTHETIC_PRIVATE_PROVIDER_ERROR",
      "offline-preflight-test-key",
      "prompt_tokens",
      "reasoning",
      "messages",
      "toolCalls",
    ]) {
      expect(encoded).not.toContain(content);
    }
  } finally {
    info.mockRestore();
  }
});

test("repeated general search measures persisted and fresh evidence in the same SDK request", async () => {
  const reply = `Each project can use 1.2 million quota units per minute, and each user can use 6k quota units per minute. [[SOURCE_URL:${GENERAL_SOURCE}]]`;
  const first = await exercise({ general: true, measureShape: true }, reply);
  expect(first.failed).toBe(false);
  expect(first.result?.internalGrounding?.kind).toBe("web_search");
  if (!first.result || first.result.internalGrounding?.kind !== "web_search")
    throw new Error("Actual first general receipt unavailable");
  const repeated = await exercise(
    {
      general: true,
      measureShape: true,
      history: first.result.history,
      expectedPriorGrounding: first.result.internalGrounding,
      messageIds: {
        user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        assistant: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    },
    reply,
  );
  expect(repeated.failed).toBe(false);
  expect(repeated.actions).toEqual([{ query: GENERAL_TOPIC, success: true }]);
  expect(repeated.result?.reply).toContain("1.2 million");
  expect(repeated.receiptCopies).toHaveLength(repeated.modelCalls);
  expect(repeated.receiptCopies.every((row) => row.priorEncodedReceiptMessages > 0)).toBe(true);
  expect(
    repeated.receiptCopies.some(
      (row) =>
        row.priorEncodedReceiptMessages > 0 &&
        row.freshActionReceiptMessages > 0 &&
        row.freshActionSourceObjectsMatchPrior > 0,
    ),
  ).toBe(true);
  const summary = {
    minimumComparedChars: 128,
    first: { core: first.coreShapes, wire: first.wireShapes },
    repeated: {
      core: repeated.coreShapes,
      wire: repeated.wireShapes,
      receipts: repeated.receiptCopies,
    },
  };
  const pending: unknown[] = [summary];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string")
      expect(["RESPONSE_HANDLER", "ACTION_PLANNER", "TEXT_SMALL", "TEXT_LARGE", "other"]).toContain(
        value,
      );
    else if (typeof value === "number") expect(Number.isFinite(value) && value >= 0).toBe(true);
    else if (value && typeof value === "object") pending.push(...Object.values(value));
    else throw new Error("Numeric repeated-search projection contains an unexpected leaf");
  }
  console.info("[offline-repeated-general-numeric]", JSON.stringify(summary));
});
