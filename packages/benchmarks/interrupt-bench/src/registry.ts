/**
 * Build the bench-specific ResponseHandlerFieldRegistry.
 *
 * Registers a minimal set that mirrors the core fields exported from
 * `@elizaos/core` PLUS the threadOps field (mirroring the one in
 * `@elizaos/app-lifeops`). We don't import the real threadOps evaluator here
 * because it pulls in plugin-side stores (work-threads, pending-prompts) that
 * require a full IAgentRuntime — out of scope for an in-process benchmark.
 *
 * The schema this produces is what gets sent to Cerebras in real-LLM mode.
 */

import {
  ResponseHandlerFieldRegistry,
  type ResponseHandlerFieldEvaluator,
} from "@elizaos/core";

const SOURCE_REF_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    kind: { type: "string" },
    id: { type: "string" },
  },
  required: ["kind", "id"],
};

const SHOULD_RESPOND_EVAL: ResponseHandlerFieldEvaluator<"RESPOND" | "IGNORE"> = {
  name: "shouldRespond",
  description:
    "Routing flag for the turn. 'RESPOND' means produce a reply or take action; 'IGNORE' means the agent should stay silent (e.g., on intermediate fragments of a streamed message or unaddressed group-chat noise).",
  priority: 0,
  schema: {
    type: "string",
    enum: ["RESPOND", "IGNORE"],
    description: "RESPOND to act or reply; IGNORE to stay silent.",
  },
};

const CONTEXTS_EVAL: ResponseHandlerFieldEvaluator<string[]> = {
  name: "contexts",
  description:
    "List of context provider names to expand for the planner. Use an empty array when the message can be handled without additional context.",
  priority: 10,
  schema: {
    type: "array",
    items: { type: "string" },
    description: "Names of context providers to gather.",
  },
};

const INTENTS_EVAL: ResponseHandlerFieldEvaluator<string[]> = {
  name: "intents",
  description:
    "Short identifiers for what the user wants this turn (e.g., 'reply_question', 'create_task', 'cancel_task'). Empty array when no intent classification applies.",
  priority: 20,
  schema: {
    type: "array",
    items: { type: "string" },
    description: "Intent identifiers.",
  },
};

const CANDIDATE_ACTIONS_EVAL: ResponseHandlerFieldEvaluator<string[]> = {
  name: "candidateActionNames",
  description:
    "Names of actions the planner should consider for this turn. Empty array when no actions apply (e.g., a pure conversational reply).",
  priority: 60,
  schema: {
    type: "array",
    items: { type: "string" },
    description: "Candidate action names.",
  },
};

const REPLY_TEXT_EVAL: ResponseHandlerFieldEvaluator<string> = {
  name: "replyText",
  description:
    "The reply the agent should emit. Empty string for IGNORE or when no direct reply applies (the agent will route to the planner instead).",
  priority: 70,
  schema: {
    type: "string",
    description: "Reply text. Empty when no direct reply.",
  },
};

const FACTS_EVAL: ResponseHandlerFieldEvaluator<string[]> = {
  name: "facts",
  description:
    "New facts extracted from the user's message that the memory pipeline should persist. Empty array when nothing new.",
  priority: 80,
  schema: {
    type: "array",
    items: { type: "string" },
    description: "Extracted facts.",
  },
};

const RELATIONSHIPS_EVAL: ResponseHandlerFieldEvaluator<Array<{
  subject: string;
  predicate: string;
  object: string;
}>> = {
  name: "relationships",
  description:
    "Relationship triples extracted from the message. Empty array when no relationships are mentioned.",
  priority: 81,
  schema: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        subject: { type: "string" },
        predicate: { type: "string" },
        object: { type: "string" },
      },
      required: ["subject", "predicate", "object"],
    },
    description: "Subject/predicate/object triples.",
  },
};

const ADDRESSED_TO_EVAL: ResponseHandlerFieldEvaluator<string[]> = {
  name: "addressedTo",
  description:
    "User ids the reply is addressed to. For a DM with one user, this is just that user. For a group chat, only include addressees whose attention the reply is for.",
  priority: 82,
  schema: {
    type: "array",
    items: { type: "string" },
    description: "User ids addressed by the reply.",
  },
};

// Mirror of app-lifeops `threadOps` field — schema duplicated here so the
// bench doesn't need a runtime database. Op types are kept in sync with the
// real evaluator.
const THREAD_OPS_EVAL: ResponseHandlerFieldEvaluator = {
  name: "threadOps",
  description:
    "Thread operations to perform on durable work threads owned by this user. Each op has a 'type' (create | steer | stop | merge | attach_source | schedule_followup | mark_waiting | mark_completed | abort). The 'abort' op preempts the rest of the turn — emit it when the user clearly retracts (\"stop\", \"nvm\", \"actually don't\"). Use 'steer' for refining an existing thread. Use 'merge' to combine threads (workThreadId is the survivor; sourceWorkThreadIds are absorbed). Use 'create' to start a new thread. Use 'stop' to cleanly close a thread without aborting the turn. Emit an empty array when no thread action is needed.",
  priority: 30,
  schema: {
    type: "array",
    description: "Thread operations for this turn.",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: [
            "create",
            "steer",
            "stop",
            "merge",
            "attach_source",
            "schedule_followup",
            "mark_waiting",
            "mark_completed",
            "abort",
          ],
        },
        workThreadId: { type: ["string", "null"] },
        sourceWorkThreadIds: { type: "array", items: { type: "string" } },
        sourceRef: SOURCE_REF_SCHEMA,
        instruction: { type: ["string", "null"] },
        reason: { type: ["string", "null"] },
      },
      required: [
        "type",
        "workThreadId",
        "sourceWorkThreadIds",
        "sourceRef",
        "instruction",
        "reason",
      ],
    },
  },
};

export function buildBenchRegistry(): ResponseHandlerFieldRegistry {
  const reg = new ResponseHandlerFieldRegistry();
  reg.register(SHOULD_RESPOND_EVAL);
  reg.register(CONTEXTS_EVAL);
  reg.register(INTENTS_EVAL);
  reg.register(CANDIDATE_ACTIONS_EVAL);
  reg.register(REPLY_TEXT_EVAL);
  reg.register(FACTS_EVAL);
  reg.register(RELATIONSHIPS_EVAL);
  reg.register(ADDRESSED_TO_EVAL);
  reg.register(THREAD_OPS_EVAL);
  return reg;
}
