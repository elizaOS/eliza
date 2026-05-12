import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.nighttime-wind-down",
  title: "Nightly wind-down request asks which apps to block",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "clarification", "time-of-day-edge"],
  description:
    "A nightly wind-down block request without specific apps should prompt for which apps to include.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Nighttime Wind Down",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "schedule-nightly-block",
      room: "main",
      text: "Block apps after 10pm every night until I go to sleep.",
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "APP_BLOCK",
      minCount: 1,
    },
  ],
});
