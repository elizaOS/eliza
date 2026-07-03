import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoActionCalled } from "../_helpers/effect-assertions.ts";

export default scenario({
  lane: "live-only",
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
      forbiddenActions: ["APP_BLOCK", "WEBSITE_BLOCK", "BLOCK"],
      assertResponse: (text) => {
        if (!/\?/.test(text)) {
          return "expected the response to ask a clarification question";
        }
        if (!/\b(app|apps|application|applications)\b/i.test(text)) {
          return "expected the response to clarify which apps to block";
        }
        if (
          !/\b(which|what|specific|include|choose|pick|select)\b/i.test(text)
        ) {
          return "expected the response to ask for the specific apps to include";
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REPLY",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the clarification contract is a NEGATIVE
      // side-effect guarantee — no block of any kind may be enforced
      // anywhere in the run while the agent is still asking which apps to
      // include. Turn-level forbiddenActions only guards its own turn.
      type: "custom",
      name: "no-block-enforced-while-clarifying",
      predicate: (ctx) =>
        expectNoActionCalled(ctx, ["APP_BLOCK", "WEBSITE_BLOCK", "BLOCK"]),
    },
  ],
});
