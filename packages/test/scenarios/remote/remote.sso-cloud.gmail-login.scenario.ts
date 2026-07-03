import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoActionCalled } from "../_helpers/effect-assertions.ts";

function expectManualGoogleLoginGuidance(
  ctx: ScenarioContext,
): string | undefined {
  const forbidden = expectNoActionCalled(ctx, [
    "REMOTE_DESKTOP",
    "BROWSER",
    "COMPUTER_USE",
  ]);
  if (forbidden) return forbidden;

  const reply = ctx.turns?.at(-1)?.responseText ?? "";
  if (
    !/google/i.test(reply) ||
    !/(sign in|login|accounts\.google\.com)/i.test(reply)
  ) {
    return `expected manual Google sign-in guidance, saw ${JSON.stringify(reply)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "remote.sso-cloud.gmail-login",
  title: "Google remote-access login request gets manual sign-in guidance",
  domain: "remote",
  tags: ["remote", "sso", "google", "guidance"],
  description:
    "A request to sign into remote access with Google currently responds with manual login guidance in chat.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote SSO Gmail Login",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "gmail-sso",
      room: "main",
      text: "Let me log into remote access with my Google account.",
      responseIncludesAny: [
        "Google",
        "sign in",
        "login",
        "accounts.google.com",
      ],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "google-sso-guidance-without-remote-side-effects",
      predicate: expectManualGoogleLoginGuidance,
    },
  ],
});
