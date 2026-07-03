import { scenario } from "@elizaos/scenario-runner/schema";
import { callPayloadBlob } from "../_helpers/effect-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "selfcontrol.block-apps.ios-capacitor",
  title: "iPhone companion block request routes through blocker planning",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "ios", "planning"],
  description:
    "An iPhone companion app-block request currently falls back to the existing blocker planning flow.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl iOS Capacitor App Block",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-ios-app-block",
      room: "main",
      text: "Use my iPhone companion to block Instagram and TikTok until 6pm tonight.",
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "APP_BLOCK",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the blocker-planning fallback must carry the
      // two requested apps through the param-resolution pipeline — an
      // APP_BLOCK call whose payload does not name both Instagram and TikTok
      // proves only that some handler ran, not that this request reached it.
      type: "custom",
      name: "ios-block-payload-names-requested-apps",
      predicate: (ctx) => {
        const blob = callPayloadBlob(ctx, "APP_BLOCK");
        if (!blob.includes("instagram") || !blob.includes("tiktok")) {
          return `expected the app-block payload to carry the requested apps (instagram/tiktok), saw: ${blob.slice(0, 300)}`;
        }
      },
    },
  ],
});
