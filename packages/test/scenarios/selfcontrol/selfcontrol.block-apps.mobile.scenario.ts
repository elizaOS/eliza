import { scenario } from "@elizaos/scenario-runner/schema";
import { callPayloadBlob } from "../_helpers/effect-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "selfcontrol.block-apps.mobile",
  title: "Phone app-block request reaches the blocker permission gate",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "mobile", "permissions"],
  description:
    "A phone app-block request currently routes into the blocker permission check instead of a mobile-only enforcement path.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Mobile App Block",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-mobile-app-block",
      room: "main",
      text: "Block Instagram and TikTok on my phone for the next 3 hours.",
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "WEBSITE_BLOCK",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the routed call must actually carry the two
      // requested apps through the param-resolution -> blocker pipeline —
      // a call whose payload does not name both Instagram and TikTok proves
      // only that some handler ran, not that this request reached it.
      type: "custom",
      name: "mobile-block-payload-names-requested-apps",
      predicate: (ctx) => {
        const blob = callPayloadBlob(ctx, "WEBSITE_BLOCK");
        if (!blob.includes("instagram") || !blob.includes("tiktok")) {
          return `expected the block payload to carry the requested apps (instagram/tiktok), saw: ${blob.slice(0, 300)}`;
        }
      },
    },
  ],
});
