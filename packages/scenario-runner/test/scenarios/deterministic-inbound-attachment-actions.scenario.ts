/**
 * Keyless coverage that an inbound text attachment flows through the message
 * pipeline to a reply. Runs on the pr-deterministic lane under the model provider;
 * live-inbound-attachment proves a real model reads and summarizes it.
 */
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

// Deterministic INBOUND attachment coverage (#8876): a user message that
// carries a `Media` attachment must flow end-to-end through a real AgentRuntime
// under the mock (deterministic) LLM and produce a reply — i.e. an inbound
// attachment never breaks the message pipeline. (Media GENERATION is covered by
// deterministic-media-actions.scenario.ts; the agent-facing read tool is
// the core `ATTACHMENT` action, unit-tested in core.) The attachment is
// surfaced into the agent's context with its stored-content hint, and the agent
// replies. Runs keyless + strict under the deterministic model provider.

const noteText = "Project kickoff is Tuesday at 10am in room 4.";
const noteDataUrl = `data:text/plain;base64,${Buffer.from(noteText).toString("base64")}`;
const attachmentInput = "Take a look at the attached note and reply.";
const replyText = "Thanks — I've got your attached note.";

export default scenario({
  id: "deterministic-inbound-attachment-actions",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "inbound-attachment-stage1-direct-reply",
        match: {
          modelType: "RESPONSE_HANDLER",
          input: { includes: attachmentInput },
        },
        response: {
          json: {
            contexts: ["simple"],
            intents: ["read attached note"],
            replyText,
            threadOps: [],
            candidateActionNames: [],
          },
        },
      },
    ],
  },
  title:
    "Deterministic inbound attachment flows through the pipeline to a reply",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "attachments", "files"],
  isolation: "shared-runtime",
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
      assertTurn: (execution: ScenarioTurnExecution) =>
        execution.responseText && execution.responseText.length > 0
          ? undefined
          : "expected a non-empty reply to the attachment message",
    },
  ],
});
