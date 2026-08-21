/**
 * Live judged owner-fidelity scenario for a Series B launch thread. The model's
 * draft is compared against explicit owner exemplars and a deliberately generic
 * consultant baseline through the trajectory judge.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "creative-owner-voice-series-b-live",
  lane: "live-only",
  title:
    "Series B launch thread is closer to owner exemplars than consultant copy",
  domain: "lifeops.creative",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "creative-draft", "owner-voice", "judge", "live", "14871"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Series B Owner Voice",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "compose the Series B launch thread",
      room: "main",
      actionName: "CREATIVE_DRAFT",
      text: "Write the Series B launch thread in my voice, not consultant voice.",
      options: {
        parameters: {
          action: "compose",
          request: {
            title: "Series B Launch",
            targetForm: "launch_thread",
            ownerAsk:
              "Write the Series B launch thread in my voice, with nerve and no corporate filler.",
            requestedVoice: "plainspoken, fast, and specific",
          },
          memos: [
            {
              id: "series-b-why-now",
              transcript:
                "We raised because the product is working and the demand is ahead of our ability to serve it, not because fundraising is the story.",
              affect: "excited",
            },
            {
              id: "series-b-credit",
              transcript:
                "Give the team and customers the credit. End with exactly what this lets us build next.",
              affect: "tender",
            },
          ],
          ownerSources: [
            {
              id: "owner-launch-one",
              source: "thread",
              text: "Look, the point is not the announcement. The point is what the work now makes possible. Say it plainly and give the builders credit.",
            },
            {
              id: "owner-launch-two",
              source: "sent_mail",
              text: "I want the useful version: direct, specific, and a little impatient with ceremony. What matters is the work and who did it.",
            },
          ],
        },
      },
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The launch thread must say fundraising is not the story, credit the team and customers, name what the round enables next, and resemble the plainspoken owner exemplars. It must be clearly closer to those exemplars than this generic baseline: 'We are thrilled to announce a best-in-class Series B that will unlock value, leverage synergies, and accelerate our robust growth framework.'",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CREATIVE_DRAFT",
      status: "success",
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "series-b-owner-fidelity-vs-consultant-baseline",
      minimumScore: 0.75,
      rubric:
        "Compare the generated Series B thread to the supplied owner exemplars and the explicit generic consultant baseline. Pass only if the draft preserves the seeded arguments and is materially closer in diction, cadence, stance, and specificity to the owner examples than to the baseline.",
    },
  ],
});
