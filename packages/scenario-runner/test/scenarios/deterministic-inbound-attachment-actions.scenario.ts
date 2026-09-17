/**
 * Keyless coverage that an inbound text attachment flows through the message
 * pipeline to a reply. Runs on the pr-deterministic lane under the model provider;
 * live-inbound-attachment proves a real model reads and summarizes it.
 */

import {
  type RuntimeWithScenarioModelFixtures,
  strictActionRouteFixtures,
} from "@elizaos/core/testing";
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

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
});
