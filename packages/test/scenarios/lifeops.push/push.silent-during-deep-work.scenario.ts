import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.silent-during-deep-work",
  title: "Suppress low-urgency pushes during a deep-work focus block",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "focus", "suppress", "do-not-disturb"],
  description:
    "A focus window is active. A low-urgency reminder (newsletter draft) wants to fire. Agent must defer it past the window — not push through. Negative-space test: dispatch should NOT happen during the window.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Silent during deep work",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "focus-window-active",
        title: "Deep work block",
        startAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        endAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "queued-push",
        title: "Send newsletter draft",
        urgency: "low",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "respect-focus",
      room: "main",
      text: "I'm in deep work for the next 90 minutes. Don't push low-priority stuff at me — defer it.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT", "LIFE"],
        description: "respect focus window — defer low-urgency",
        includesAny: ["focus", "deep work", "defer", "later"],
      }),
      responseIncludesAny: ["defer", "after", "focus", "deep work"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must commit to deferring low-urgency pushes until after the focus window. Pushing during the window fails. 'Got it' without naming the deferral fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT", "LIFE"],
    },
    {
      type: "custom",
      name: "push-silent-focus-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "LIFE"],
        description: "deep-work suppression",
      }),
    },
    judgeRubric({
      name: "push-silent-focus-rubric",
      threshold: 0.7,
      description:
        "Low-urgency push was deferred past the focus window — not pushed through.",
    }),
  ],
});
