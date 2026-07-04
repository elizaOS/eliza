/**
 * Live-lane scenario: a real LLM reads and summarizes an inbound text attachment.
 * Needs live model credentials (live-only lane); the deterministic twin is
 * deterministic-inbound-attachment-actions.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

// Real-LLM (live lane) counterpart of deterministic-inbound-attachment-actions
// (#8876). Same inbound-attachment flow, but routed through a REAL model with no
// fixtures: the agent must read the attached note's content and reflect it back.
// Runs only in the credentialed live lane (needs provider keys); the keyless PR
// lane runs the deterministic version. The "we ALSO test/validate with a real
// LLM" requirement — turnkey: it executes as soon as model keys are present.

const noteText = "Project kickoff is Tuesday at 10am in room 4.";
const noteDataUrl = `data:text/plain;base64,${Buffer.from(noteText).toString("base64")}`;

export default scenario({
  id: "live-inbound-attachment",
  lane: "live-only",
  title: "Real LLM reads and summarizes an inbound text attachment",
  domain: "attachments",
  tags: ["live", "real-llm", "attachments", "files"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Inbound Attachment (live)",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "summarize the attached note",
      room: "main",
      text: "Read the attached note and tell me the key details.",
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
      // A capable model that actually consumed the attachment will surface at
      // least one concrete detail from it.
      responseIncludesAny: ["kickoff", "Tuesday", "10", "room 4", "room"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The reply must reflect the content of the attached note (a project kickoff on Tuesday at 10am in room 4), naming at least one concrete detail from it. A generic reply that ignores the attachment's content fails.",
      },
    },
  ],
});
