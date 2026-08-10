/**
 * Draft with CC and BCC — the agent must include both recipient sets in the
 * curated `create_draft` arguments and must not confuse cc/bcc/to roles.
 *
 * Failure modes guarded:
 *   - CC'ing the BCC recipient
 *   - dropping BCC entirely
 *   - sending without approval
 *
 * Cited: 03-coverage-gap-matrix.md — multi-recipient drafts.
 */

import { judgeRubric } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  gmailCreateDraftFixture,
  gmailDefaultSearchFixture,
} from "../../../scenario-support/gmail-mcp-fixtures.ts";

export default scenario({
  lane: "live-only",
  id: "gmail.create-draft-with-cc-bcc",
  title: "Draft with CC and BCC keeps roles distinct",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "draft", "cc", "bcc"],
  isolation: "per-scenario",
  requires: {
    credentials: ["gmail:test-owner"],
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Gmail Draft CC BCC",
    },
  ],
  seed: [
    gmailDefaultSearchFixture(),
    gmailCreateDraftFixture({ clearLedger: false }),
  ],
  turns: [
    {
      kind: "message",
      name: "draft-with-cc-bcc",
      room: "main",
      text: "Draft an email to alice@example.com about the project update. CC bob@example.com on it, and BCC counsel@legal.example. Don't send.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Reply must produce a draft that lists alice as TO, bob as CC, and counsel@legal.example as BCC. Must not confuse the roles or claim it was sent.",
      },
    },
  ],
  finalChecks: [
    {
      type: "mcpToolCall",
      provider: "google",
      resource: "gmail",
      tool: "create_draft",
      arguments: {
        to: ["alice@example.com"],
        cc: ["bob@example.com"],
        bcc: ["counsel@legal.example"],
      },
      minCount: 1,
    },
    judgeRubric({
      name: "gmail-draft-cc-bcc-rubric",
      threshold: 0.7,
      description:
        "Agent drafted with distinct TO (alice), CC (bob), BCC (counsel@legal.example) fields and did not send.",
    }),
  ],
});
