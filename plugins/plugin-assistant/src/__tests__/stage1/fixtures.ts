/** Shared deterministic Stage-1 fixtures; no production exports. */

import { PseudonymSession } from "@elizaos/core";
import type {
  Action,
  CandidateActionBackstopRule,
  IAgentRuntime,
  Memory,
  ResponseHandlerEvaluator,
  State,
} from "@elizaos/core/protocol";
import {
  ChannelType,
  GazetteerEntityRecognizer,
  ResponseHandlerFieldRegistry,
  type UUID,
} from "@elizaos/core/protocol";
import { vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../runtime/builtin-field-evaluators.js";
import {
  applyHistoryRetentionReview,
  prepareHistoryRetention,
} from "../../runtime/history-retention.js";
import {
  commitEvaluatorProgress,
  prepareEvaluatorProgress,
  stageEvaluatorOutput,
} from "../../services/evaluator-progress.js";
import {
  historyRetentionContext,
  historyRetentionEvaluator,
} from "../../services/history-retention.js";
import { runV5MessageRuntimeStage1 } from "../../services/message.js";

export const SCHEDULING_BACKSTOP_RULE: CandidateActionBackstopRule = {
  actionNames: [
    "SCHEDULED_TASKS",
    "SCHEDULED_TASKS_ACKNOWLEDGE",
    "SCHEDULED_TASKS_CANCEL",
    "SCHEDULED_TASKS_COMPLETE",
    "SCHEDULED_TASKS_CREATE",
    "SCHEDULED_TASKS_DISMISS",
    "SCHEDULED_TASKS_GET",
    "SCHEDULED_TASKS_HISTORY",
    "SCHEDULED_TASKS_LIST",
    "SCHEDULED_TASKS_REOPEN",
    "SCHEDULED_TASKS_SKIP",
    "SCHEDULED_TASKS_SNOOZE",
    "SCHEDULED_TASKS_UPDATE",
  ],
  matches: (text: string): boolean =>
    /\b(?:remind\s+me|reminder|scheduled\s+task|scheduled\s+item|todo|to[- ]?do|snooze|recap|check[- ]?in|follow[- ]?up|watcher|approval)\b/iu.test(
      text,
    ) ||
    /\b(?:schedule|create|make|add|set\s+up)\b[\s\S]{0,80}\b(?:task|reminder|todo|to[- ]?do|check[- ]?in|follow[- ]?up|watcher|recap|approval)\b/iu.test(
      text,
    ) ||
    /\b(?:tomorrow|tonight|later|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|every\s+(?:day|week|month|morning|evening))\b/iu.test(
      text,
    ),
};

export function useModelCalls(runtime: IAgentRuntime): unknown[][] {
  return (runtime.useModel as { mock: { calls: unknown[][] } }).mock.calls;
}

export function reportErrorCalls(runtime: IAgentRuntime): unknown[][] {
  return (runtime.reportError as { mock: { calls: unknown[][] } }).mock.calls;
}

export function makeMessage(content: Partial<Memory["content"]> = {}): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001" as UUID,
    entityId: "00000000-0000-0000-0000-000000000002" as UUID,
    agentId: "00000000-0000-0000-0000-000000000003" as UUID,
    roomId: "00000000-0000-0000-0000-000000000004" as UUID,
    content: {
      text: "Can you check my calendar?",
      source: "test",
      ...content,
    },
    createdAt: 1,
  };
}

export type Stage1Input = Parameters<typeof runV5MessageRuntimeStage1>[0];

export function runStage1(
  input: Omit<Stage1Input, "state" | "responseId"> &
    Partial<Pick<Stage1Input, "state" | "responseId">>,
) {
  return runV5MessageRuntimeStage1({
    state: makeState(),
    responseId: "00000000-0000-0000-0000-000000000005" as UUID,
    ...input,
  });
}

export function makeState(): State {
  return {
    values: {
      availableContexts: "general, calendar",
    },
    data: {},
    text: "Recent conversation summary",
  };
}

export function addDeferredReference(runtime: IAgentRuntime, state: State) {
  const providers = {
    userPersonalityPreferences: {
      text: "First private reference body.".repeat(8),
      discoveryText: "context_discovery: userPersonalityPreferences",
    },
    BOT_AWARENESS: {
      text: "Second private reference body.".repeat(8),
      discoveryText: "context_discovery: BOT_AWARENESS",
    },
  };
  state.data.providers = { ...state.data.providers, ...providers };
  runtime.providers = Object.entries(providers).map(([name, value]) => ({
    name,
    get: async () => value,
  }));
}

export function makeAttachmentState(): State {
  return {
    values: {
      availableContexts: "general, media, messaging",
    },
    data: {
      providers: {
        ATTACHMENTS: {
          data: {
            attachments: [
              {
                id: "image-1",
                url: "https://cdn.example.test/image.png",
                title: "Image Attachment",
                source: "Image",
                contentType: "image",
              },
            ],
            visibleAttachments: [
              {
                id: "image-1",
                url: "https://cdn.example.test/image.png",
                title: "Image Attachment",
                source: "Image",
                contentType: "image",
              },
            ],
          },
        },
        RECENT_MESSAGES: {
          data: {
            recentMessages: [
              {
                id: "00000000-0000-0000-0000-000000000011" as UUID,
                entityId: "00000000-0000-0000-0000-000000000002" as UUID,
                agentId: "00000000-0000-0000-0000-000000000003" as UUID,
                roomId: "00000000-0000-0000-0000-000000000004" as UUID,
                createdAt: 1,
                content: {
                  text: "can you see this image?",
                  source: "test",
                },
              },
            ],
          },
        },
      },
    },
    text: "provider:ATTACHMENTS\n# Attachments\nID: image-1",
  };
}

export function stage1Response(fields: {
  contextRequests?: string[];
  shouldRespond?: "RESPOND" | "IGNORE" | "STOP";
  thought?: string;
  contexts?: string[];
  intents?: string[];
  candidateActionNames?: string[];
  replyText?: string;
  replyParts?: boolean;
  facts?: string[];
  relationships?: unknown[];
  addressedTo?: string[];
  extra?: Record<string, unknown>;
}) {
  return {
    text: "",
    toolCalls: [
      {
        id: "handle-response-1",
        name: "HANDLE_RESPONSE",
        arguments: {
          shouldRespond: fields.shouldRespond ?? "RESPOND",
          thought: fields.thought ?? "",
          contexts: fields.contexts ?? [],
          intents: fields.intents ?? [],
          candidateActionNames: fields.candidateActionNames ?? [],
          contextRequests: fields.contextRequests ?? [],
          replyText: fields.replyParts
            ? [{ kind: "text", value: fields.replyText ?? "" }]
            : (fields.replyText ?? ""),
          facts: fields.facts ?? [],
          relationships: fields.relationships ?? [],
          addressedTo: fields.addressedTo ?? [],
          ...(fields.extra ?? {}),
        },
      },
    ],
  };
}

export function plannerReplyRejectedByEgress() {
  return {
    text: "",
    toolCalls: [
      {
        id: "reply-1",
        name: "REPLY",
        arguments: { text: "We need to call SEARCH for that." },
      },
    ],
  };
}

export function acceptedRecoveryReview(reason: string) {
  return JSON.stringify({
    grounded: true,
    completedChangeClaim: false,
    reason,
  });
}

export function makeRuntime(
  responses: unknown[],
  settings?: Record<string, string>,
  evaluators?: ResponseHandlerEvaluator[],
): IAgentRuntime {
  const queue = [...responses];
  const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
  for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
    responseHandlerFieldRegistry.register(evaluator);
  }
  return {
    agentId: "00000000-0000-0000-0000-000000000003" as UUID,
    character: {
      name: "Test Agent",
      system: "You are concise.",
      bio: "I help with calendars.",
    },
    actions: [],
    providers: [],
    getService: vi.fn(() => null),
    getRoom: vi.fn(async () => null),
    getModelRegistrations: vi.fn(() => []),
    composeState: vi.fn(async () => makeState()),
    runActionsByMode: vi.fn(async () => undefined),
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
    useModel: vi.fn(async () => {
      if (queue.length === 0) {
        throw new Error("Unexpected useModel call");
      }
      return queue.shift();
    }),
    getSetting: vi.fn((key: string) => settings?.[key]),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    },
    responseHandlerFieldRegistry,
    responseHandlerFieldEvaluators: [
      ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
    ],
    responseHandlerEvaluators: evaluators ?? [],
  } as IAgentRuntime;
}

export async function reviewedHistoryFixture(
  initialRole?: "ADMIN" | "GUEST",
  originals?: Memory[],
) {
  const runtime = makeRuntime([]);
  const message = makeMessage({ channelType: ChannelType.DM, text: "hi" });
  message.createdAt = 20;
  const world = {
    id: "00000000-0000-0000-0000-000000000091" as UUID,
    agentId: runtime.agentId,
    metadata: { roles: { [message.entityId]: initialRole ?? "GUEST" } },
  };
  if (initialRole) {
    runtime.getRoom = async () => ({
      id: message.roomId,
      agentId: runtime.agentId,
      worldId: world.id,
      source: "test",
      type: ChannelType.DM,
    });
    runtime.getWorld = async () => world;
  }
  const rows: Memory[] =
    originals ??
    [
      "Never change my records without my explicit request.",
      "The old literal label was blueberry  :  first.\n",
      "Acknowledged the old literal label.",
      "hello from the previous exchange",
      "Hey from the previous exchange.",
      // Keep the deferred originals older than the ten-message continuity
      // window so these tests still exercise authorized historical reads.
      ...Array.from({ length: 8 }, (_, i) => `Ordinary recent exchange ${i}.`),
    ].map((text, i) => ({
      ...message,
      id: `00000000-0000-0000-0000-${String(10 + i).padStart(12, "0")}` as UUID,
      createdAt: i + 1,
      entityId:
        i === 2 || i === 4 || (i > 4 && i % 2 === 0)
          ? runtime.agentId
          : message.entityId,
      content: { text },
    }));
  message.createdAt = Math.max(
    20,
    ...rows.map((row) => Number(row.createdAt ?? 0) + 1),
  );
  const cache = new Map<string, unknown>();
  runtime.getCache = async <T>(key: string) =>
    structuredClone(cache.get(key)) as T | undefined;
  runtime.setCache = async <T>(key: string, value: T) => {
    cache.set(key, structuredClone(value));
    return true;
  };
  runtime.getMemories = vi.fn(async () => structuredClone(rows));
  Object.assign(runtime, { evaluators: [historyRetentionEvaluator] });
  const scope = { agentId: runtime.agentId, roomId: message.roomId };
  const prepared = prepareHistoryRetention(
    historyRetentionContext(runtime, message, rows),
    scope,
    null,
    "fixture-reviewed-originals",
    rows.length,
  );
  const checkpoint = applyHistoryRetentionReview(prepared, {
    sourceSetId: prepared.sourceSetId,
    complete: true,
    retainSourceIds: ["h1"],
    deferSourceIds: rows.slice(1).map((_, i) => `h${i + 2}`),
    uncertainSourceIds: [],
    dependencyGroups: [],
  });
  const trigger = rows.find((row) => row.entityId === message.entityId);
  if (!trigger) throw new Error("Missing fixture owner message");
  const progress = (
    await prepareEvaluatorProgress(
      runtime,
      trigger,
      [historyRetentionEvaluator.name],
      rows,
    )
  ).get(historyRetentionEvaluator.name);
  if (!progress) throw new Error("Missing fixture journal");
  await stageEvaluatorOutput(runtime, progress, { fixture: true });
  await commitEvaluatorProgress(runtime, progress, { ...checkpoint });
  const state = makeState();
  state.data.providers = {
    RECENT_MESSAGES: { data: { recentMessages: rows } },
  };
  runtime.composeState = vi.fn(async () => structuredClone(state));
  return { runtime, message, rows, cache, state, world };
}

export function makeMemorySearchAction(
  minRole: "USER" | "OWNER" = "USER",
): Action {
  return {
    name: "MEMORY",
    description: "Search stored conversation records.",
    contexts: ["memory"],
    roleGate: { minRole },
    parameters: [
      {
        name: "action",
        description: "Memory operation.",
        schema: { type: "string", enum: ["search"] },
      },
    ],
    validate: async () => true,
    handler: async () => ({
      success: true,
      text: "Found stored conversation records.",
    }),
  };
}

export function makePiiSession(): PseudonymSession {
  return new PseudonymSession({
    salt: "fixed",
    recognizer: new GazetteerEntityRecognizer([
      { kind: "person", value: "Dana Whitfield" },
      { kind: "org", value: "Acme Robotics" },
    ]),
  });
}

export async function seededPiiSession(): Promise<{
  session: PseudonymSession;
  dana: string;
  acme: string;
}> {
  const session = makePiiSession();
  await session.learn("Dana Whitfield works at Acme Robotics.");
  const dana = session.entries.find(
    (entry) => entry.value === "Dana Whitfield",
  )?.surrogate;
  const acme = session.entries.find(
    (entry) => entry.value === "Acme Robotics",
  )?.surrogate;
  if (!dana || !acme) {
    throw new Error("PII test session did not mint expected surrogates");
  }
  return { session, dana, acme };
}

export function withRoomEntities(runtime: IAgentRuntime): IAgentRuntime {
  (runtime as unknown as Record<string, unknown>).getEntitiesForRoom = vi.fn(
    async () => [
      {
        id: "00000000-0000-0000-0000-000000000003" as UUID,
        names: ["Test Agent"],
      },
      {
        id: "00000000-0000-0000-0000-0000000000bb" as UUID,
        names: ["OtherBot"],
      },
      { id: "00000000-0000-0000-0000-0000000000cc" as UUID, names: ["Alice"] },
    ],
  );
  return runtime;
}

export function withReplyGateMode(
  runtime: IAgentRuntime,
  mode: string,
): IAgentRuntime {
  const slot = { reply_gate: mode };
  (runtime as unknown as Record<string, unknown>).getService = vi.fn(
    (type: string) =>
      type === "PERSONALITY_STORE" ? { getSlot: () => slot } : null,
  );
  return runtime;
}

export function withReplyGateSlots(
  runtime: IAgentRuntime,
  userMode: string,
  globalMode: string,
): IAgentRuntime {
  (runtime as unknown as Record<string, unknown>).getService = vi.fn(
    (type: string) =>
      type === "PERSONALITY_STORE"
        ? {
            getSlot: (id: UUID | "global") => ({
              reply_gate: id === "global" ? globalMode : userMode,
            }),
          }
        : null,
  );
  return runtime;
}
