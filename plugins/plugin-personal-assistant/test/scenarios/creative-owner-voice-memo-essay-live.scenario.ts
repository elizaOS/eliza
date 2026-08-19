/**
 * Live judged creative workflow for two STT-produced memo transcripts: the
 * essay must retain both arguments, keep the angry passage sharp, and preserve
 * an accepted edit when the standing document is revised on the next turn.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const ownerSources = [
  {
    id: "owner-essay-live",
    source: "essay",
    text: "Look, I think the point is simple. Say the hard thing plainly because people can feel when we sand the edges off.",
  },
  {
    id: "owner-mail-live",
    source: "sent_mail",
    text: "What matters is keeping the heat where the heat belongs. The useful version is direct and specific.",
  },
] as const;

export default scenario({
  id: "creative-owner-voice-memo-essay-live",
  lane: "live-only",
  title:
    "Two voice memos become an owner-voice essay whose accepted edit survives revision",
  domain: "lifeops.creative",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "creative-draft", "voice", "judge", "live", "14871"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Owner Voice Memo Essay",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "compose the angry and hopeful memos",
      room: "main",
      actionName: "CREATIVE_DRAFT",
      text: "Turn these voice memos into an essay in my voice, and keep the anger in the first section.",
      options: {
        parameters: {
          action: "compose",
          request: {
            title: "The Honest Version",
            targetForm: "essay",
            ownerAsk:
              "Turn these voice memos into an essay in my voice, not consultant voice.",
            requestedVoice: "direct, specific, and unsanded",
          },
          memos: [
            {
              id: "memo-live-anger",
              transcript:
                "They wasted six months and then asked everyone else to call it strategy.",
              affect: "angry",
              toneDirective:
                "Keep this anger sharp; do not euphemize the waste.",
            },
            {
              id: "memo-live-hope",
              transcript:
                "We can still build the honest version if we stop hiding behind process.",
              affect: "reflective",
            },
          ],
          ownerSources,
        },
      },
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The essay must retain both seeded arguments, explicitly preserve the anger about six wasted months in the mapped passage, close on building the honest version, and sound direct and specific rather than like a consultant.",
      },
    },
    {
      kind: "action",
      name: "revise the standing document without losing the approved opening",
      room: "main",
      actionName: "CREATIVE_DRAFT",
      text: "The opening is approved. Tighten the second section, and never use best-in-class.",
      options: {
        parameters: {
          action: "revise",
          ownerSources,
          revision: {
            instruction:
              "Keep the approved opening, tighten the hopeful close, and never use best-in-class.",
            acceptedEdit: "Opening approved exactly as written.",
            vetoedPhrase: "best-in-class",
            sectionIndex: 1,
            replacementText:
              "We can still build the honest version. Stop hiding behind process and build it.",
            revisedAt: "2026-08-06T12:00:00.000Z",
          },
        },
      },
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The revision must keep the approved angry opening, sharpen only the hopeful close, avoid the vetoed phrase best-in-class, and still sound like the supplied owner exemplars.",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CREATIVE_DRAFT",
      status: "success",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "memo-essay-owner-voice-and-revision-rubric",
      minimumScore: 0.75,
      rubric:
        "End-to-end: two affected memo transcripts became one owner-voice essay, the angry argument was not smoothed away, the hopeful argument remained, and a later revision updated the persisted standing draft while preserving the accepted opening and vetoed phrase.",
    },
  ],
});
