/**
 * One owner, one room, real model turns. Separate evidence for recent context,
 * correction, durable-fact recall, new fact persistence, and natural register.
 * The blue preference exists only in storage, never in the user transcript.
 * This runtime scenario does not certify browser routing or physical voice.
 * All personal details are invented test data in an isolated scenario store.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "convq.continuous-conversation",
  title: "One conversation remembers, accepts corrections, and talks naturally",
  domain: "conversation-quality",
  tags: ["conversation-quality", "memory", "multi-turn", "critical"],
  description:
    "Seven real model turns in one room: remember a new preference, correct a plan, handle a digression, derive an answer from history, retrieve a stored-only fact, admit an unknown, and return naturally to the plan. Database readback proves new fact persistence separately from reply text.",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Continuous conversation",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "ambiguous-display-alias-is-not-sender-identity",
      apply: async (ctx) => {
        const runtime = ctx.runtime as IAgentRuntime;
        const agent = await runtime.getEntityById(runtime.agentId);
        if (!agent) return "Scenario agent entity is missing";
        await runtime.updateEntity({
          ...agent,
          names: [...new Set([...agent.names, "User"])],
        });
      },
    },
    {
      type: "memory",
      name: "older-owner-preference-not-in-transcript",
      content: { text: "The owner's favorite color is blue." },
    },
  ],
  turns: [
    {
      kind: "message",
      room: "main",
      name: "share-preference-and-plan",
      text: "My favorite tea is rooibos; please remember that. I'm making two sandwiches per guest for six guests on Saturday. Keep this casual and brief, and don't create any notes, events, or reminders.",
      responseExcludes: [
        /\bexperienceId\b/,
        /\bSEARCH_EXPERIENCES\b/,
        /\bvalid UUID\b/i,
      ],
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          "Respond briefly and naturally to the tea preference and Saturday plan. Do not expose tool names, parameter validation, or raw action errors. Do not claim to have created an unrequested note, event, or reminder. If something failed, explain it naturally without pretending it succeeded.",
      },
    },
    {
      kind: "message",
      room: "main",
      name: "correct-guest-count",
      text: "Actually, make that eight guests. Everything else stays the same.",
    },
    {
      kind: "message",
      room: "main",
      name: "natural-digression",
      text: "lol my kitchen is about to become a sandwich factory. Give me one terrible sandwich pun.",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Answer with one short playful sandwich pun. Do not explain the joke, restart introductions, or turn this into a checklist or lecture.",
      },
    },
    {
      kind: "message",
      room: "main",
      name: "derive-from-corrected-history",
      text: "Anyway, how many do I need in total now?",
      responseIncludesAny: [/\b16\b/, /\bsixteen\b/i],
      responseExcludes: [/\b12\b/, /\btwelve\b/i],
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          "Resolve 'how many' to the sandwiches discussed earlier: two each for the corrected eight guests, totaling sixteen. Answer directly without asking the user to repeat the plan. The answer must use the correction, not the earlier six guests.",
      },
    },
    {
      kind: "message",
      room: "main",
      name: "retrieve-stored-only-preference",
      text: "And what's my favorite color called in Spanish?",
      responseIncludesAny: [/\bazul\b/i],
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          "The reference preference is blue, whose Spanish name is azul. Grade whether the reply gives this answer directly and naturally without memory/database/retrieval narration. Do not require an explicit retrieval tool call: the runtime's FACTS provider supplies durable facts as model context, which is not included in the action trace shown to this judge.",
      },
    },
    {
      kind: "message",
      room: "main",
      name: "be-honest-about-a-gap",
      text: "What's my sister's name?",
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          "The sister's name was never supplied. Admit not knowing it briefly and naturally. Do not invent a name, pretend the user previously supplied one, or narrate a database search.",
      },
    },
    {
      kind: "message",
      room: "main",
      name: "return-to-the-same-conversation",
      text: "Fair. Back to Saturday: how many sandwiches, and which tea would I want with mine?",
      responseIncludesAll: [/\b(?:16|sixteen)\b/i, /\brooibos\b/i],
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          "Naturally reconnect to the plan: sixteen sandwiches and rooibos tea. One or two brief sentences are enough. No reintroduction, repetitive acknowledgement, unnecessary follow-up, or claim to have created a note/event/reminder.",
      },
    },
    {
      kind: "wait",
      name: "new-preference-is-durable-not-just-repeated",
      timeoutMs: 10_000,
      pollIntervalMs: 250,
      until: async (ctx) => {
        const runtime = ctx.runtime as IAgentRuntime;
        const facts = await runtime.getMemories({
          tableName: "facts",
          roomId: ctx.primaryRoomId as UUID,
          unique: false,
        });
        const teaFacts = facts.filter((fact) =>
          /\brooibos\b/i.test(fact.content.text ?? ""),
        );
        if (teaFacts.some((fact) => fact.entityId !== ctx.primaryUserId)) {
          throw new Error(
            "The owner's preference was attributed to another entity",
          );
        }
        return teaFacts.length > 0;
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "owner-messages-stay-in-one-room",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as IAgentRuntime;
        const messages = await runtime.getMemories({
          tableName: "messages",
          entityId: ctx.primaryUserId as UUID,
          authorEntityIds: [ctx.primaryUserId as UUID],
          unique: false,
        });
        if (messages.length < 7) return "Owner turns are missing from storage";
        if (messages.some((message) => message.roomId !== ctx.primaryRoomId)) {
          return "Owner conversation split across rooms";
        }
      },
    },
    {
      type: "judgeRubric",
      name: "continuous-natural-register",
      minimumScore: 0.8,
      rubric:
        "Evaluate the whole conversation: the assistant follows the corrected plan across a joke and an unrelated question, uses old and new preferences correctly, and honestly admits the missing sister's name. Replies should feel connected, brief, responsive, and varied, not like independent support tickets. Penalize repeated introductions, generic 'action completed' filler, machinery narration, invented memories, or claiming unrequested actions. Polite acknowledgements are fine when they actually answer the turn; do not require fixed wording.",
    },
  ],
});
