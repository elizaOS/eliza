import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";
import { seedXReadFixtures } from "../_helpers/x-seeds.ts";

export default scenario({
  id: "twitter.dm.reply-in-character",
  title: "Reply to Twitter DM in user's typical tone",
  domain: "messaging.twitter-dm",
  tags: ["messaging", "twitter", "parameter-extraction"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed-twitter-dm-context",
      apply: seedXReadFixtures({
        dms: [
          {
            externalDmId: "twitter-dm-character-1",
            senderHandle: "milady_art",
            senderId: "442211",
            text: "can you send me a quick update on where the concept sketch stands?",
            offsetMinutes: 6,
          },
        ],
      }),
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Twitter DM Reply In Character",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "draft in character reply",
      room: "main",
      text: "Draft a reply to that Twitter DM from @milady_art in my usual tone.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["X_READ", "INBOX", "OWNER_SEND_MESSAGE"],
        description: "Twitter/X DM draft in the owner's tone",
        includesAny: ["x", "dm", "draft", "milady_art"],
      }),
      responseIncludesAny: [/draft|preview/i, /milady_art/i, /update|sketch/i],
      responseJudge: {
        rubric:
          "Reply matches the user's typical tone (informal, lowercase, concise) and addresses the @milady_art DM context.",
        minimumScore: 0.7,
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["X_READ", "INBOX", "OWNER_SEND_MESSAGE"],
    },
    {
      type: "draftExists",
      channel: "x-dm",
      expected: true,
    },
    {
      type: "custom",
      name: "twitter-dm-reply-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["X_READ", "INBOX", "OWNER_SEND_MESSAGE"],
        description: "Twitter/X DM draft in the owner's tone",
        includesAny: ["x", "dm", "draft", "milady_art"],
      }),
    },
    judgeRubric({
      name: "twitter-dm-reply-rubric",
      threshold: 0.7,
      description:
        "The assistant should draft an in-character X/Twitter DM reply that reflects the owner's informal concise tone and the seeded DM context.",
    }),
  ],
});
