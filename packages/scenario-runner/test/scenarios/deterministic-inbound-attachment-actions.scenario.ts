/**
 * Keyless coverage that an inbound text attachment flows through the message
 * pipeline to a reply. Runs on the pr-deterministic lane under the model provider;
 * live-inbound-attachment proves a real model reads and summarizes it.
 */

import type { AgentRuntime, UUID } from "@elizaos/core";
import {
  type RuntimeWithScenarioModelFixtures,
  strictActionRouteFixtures,
} from "@elizaos/core/testing";
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  matchesTypedTurnInput,
  typedTurnEvaluationFixtures,
} from "../../../test/scenarios/_fixtures/simple-turn-memory.ts";

const noteText = "Project kickoff is Tuesday at 10am in room 4.";
const noteDataUrl = `data:text/plain;base64,${Buffer.from(noteText).toString("base64")}`;
const attachmentInput = "Take a look at the attached note and reply.";
const replyText = noteText;
const attachmentAnswerPrompt = [
  "You are answering a user request about an attachment.",
  "Use only the attachment content, extracted text, transcript, or media description below.",
  'Follow explicit formatting instructions from the user, including requests such as "only" or "keep it short".',
  "If the requested answer is not in the attachment content, say that briefly.",
  "Do not include attachment metadata, IDs, source labels, or implementation details.",
  "",
  `User request:\n${attachmentInput}`,
  "",
  `Attachment content:\n${noteText}`,
].join("\n");

export default scenario({
  id: "deterministic-inbound-attachment-actions",
  lane: "pr-deterministic",
  title:
    "Deterministic inbound attachment flows through the pipeline to a reply",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "attachments", "files"],
  isolation: "shared-runtime",
  seed: [
    {
      type: "custom",
      name: "register the deterministic reply for the inbound attachment turn",
      apply: (ctx) => {
        const runtime = ctx.runtime as RuntimeWithScenarioModelFixtures;
        if (!runtime.scenarioModelFixtures)
          throw new Error("Model fixtures unavailable");
        // The received note supplies a current schedule context. Preserve its
        // relative day/time exactly rather than inventing a date or timezone.
        runtime.scenarioModelFixtures.register(
          ...typedTurnEvaluationFixtures(ctx.runtime as AgentRuntime, ctx, {
            name: "inbound-kickoff-note",
            input: attachmentInput,
            action: "ATTACHMENT",
            goal: { goalFound: false, goal: "", confidence: 0 },
            memory: ({ sourceMessageIds }) => ({
              factMemory: {
                ops:
                  sourceMessageIds.length === 0
                    ? []
                    : [
                        {
                          op: "add_current",
                          category: "schedule_context",
                          claim: noteText,
                          structured_fields: {},
                          keywords: ["project", "kickoff", "tuesday", "room"],
                          sourceMessageIds,
                          reason:
                            "The user supplied this complete schedule in the received note.",
                        },
                      ],
              },
              relationships: { relationships: [] },
              identities: { identities: [] },
              preferences: { ops: [] },
              experiencePatterns: { experiences: [] },
              success: {
                completed: true,
                reason:
                  "The attachment was read and its complete note returned to the user.",
              },
            }),
          }),
        );
        const [routing, planner, evaluator] = strictActionRouteFixtures({
          actionName: "ATTACHMENT",
          input: attachmentInput,
          contextIds: ["files"],
          args: { action: "read", attachmentId: "note-1" },
          messageToUser: replyText,
        });
        runtime.scenarioModelFixtures.register(routing, planner, evaluator, {
          name: "answer-complete-inbound-note",
          match: { modelType: "TEXT_SMALL", prompt: attachmentAnswerPrompt },
          response: replyText,
          times: 1,
        });
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Inbound Attachment",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "user sends a text attachment and the agent replies",
      text: attachmentInput,
      content: {
        attachments: [
          {
            id: "note-1",
            url: noteDataUrl,
            contentType: "document",
            title: "note.txt",
            mimeType: "text/plain",
            text: noteText,
          },
        ],
      },
      responseIncludesAny: [replyText],
      assertTurn: (execution: ScenarioTurnExecution) => {
        const action = execution.actionsCalled.find(
          (candidate) => candidate.actionName === "ATTACHMENT",
        );
        if (
          action?.result?.success !== true ||
          !action.result.text?.includes(noteText)
        ) {
          return "The attachment reader did not return the complete received note";
        }
        return execution.responseText?.includes(noteText)
          ? undefined
          : "The reply omitted the received note contents";
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "typed evaluator persisted the declared fact with original user evidence",
      predicate: async (ctx) => {
        if (!ctx.primaryRoomId || !ctx.primaryUserId)
          return "Fact assertion requires scenario identities";
        const runtime = ctx.runtime as AgentRuntime;
        const facts = await runtime.getMemories({
          tableName: "facts",
          roomId: ctx.primaryRoomId,
          entityId: ctx.primaryUserId,
          unique: false,
        });
        const fact = facts.find((entry) => entry.content.text === noteText);
        if (
          fact?.metadata?.category !== "schedule_context" ||
          fact.metadata?.kind !== "current"
        )
          return "Typed evaluator did not persist the declared fact";
        const revisions = fact.metadata?.extractionSourceRevisions;
        if (
          !revisions ||
          typeof revisions !== "object" ||
          Array.isArray(revisions)
        )
          return "Extracted fact lacks source revisions";
        for (const id of Object.keys(revisions)) {
          const source = await runtime.getMemoryById(id as UUID);
          if (
            source?.entityId === ctx.primaryUserId &&
            matchesTypedTurnInput(source.content.text, attachmentInput)
          )
            return undefined;
        }
        return "Extracted fact does not cite its original user message";
      },
    },
  ],
});
