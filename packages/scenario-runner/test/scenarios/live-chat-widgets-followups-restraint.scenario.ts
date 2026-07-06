/**
 * Live-model FOLLOWUPS restraint (#14322). The uiWidgets guide ends with
 * "ONLY when a follow-up genuinely helps — never to pad": a plain factual
 * question must come back as a plain answer, with no [FOLLOWUPS] chips and no
 * other widget markers bolted on. This is the negative-space check for the
 * marker vocabulary — a model that pads every reply with chips makes the
 * widget system noise. (Simple factual turns may resolve on the Stage-1 fast
 * path where the guide is not even composed; that path trivially satisfies
 * the contract, and planner-path turns are covered by the assertion all the
 * same.) Needs live model credentials (live-only lane).
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { uiWidgetsGuideSeed } from "./_helpers/chat-widgets";

export default scenario({
  id: "live-chat-widgets-followups-restraint",
  lane: "live-only",
  title: "Real LLM answers a factual question without padding on [FOLLOWUPS]",
  domain: "chat-widgets",
  tags: ["live", "real-llm", "chat-widgets", "followups"],
  isolation: "per-scenario",
  seed: [uiWidgetsGuideSeed()],
  rooms: [
    {
      id: "main",
      source: "eliza-app",
      title: "Chat Widgets Followups",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "plain factual question gets a plain answer, no widget markers",
      room: "main",
      text: "What year did the Apollo 11 moon landing happen?",
      responseIncludesAny: [/1969/],
      responseExcludes: [
        /\[FOLLOWUPS/,
        /\[FORM\]/,
        /\[CONFIG:/,
        /\[CHECKLIST\]/,
        /\[WORKFLOW\]/,
      ],
    },
  ],
});
