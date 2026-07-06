/**
 * Onboarding journey — channel answer for a channel with no connected
 * dispatcher. The owner picks a notification channel (telegram) that is not
 * connected in this runtime; onboarding must record the choice with
 * `fallbackToInApp: true` and surface a warning rather than silently promising
 * delivery it cannot make. The LIVE message turn records the model's handling
 * (trajectory evidence); pass/fail is the DOMAIN contract, since first-run is
 * conductor-driven, not model-invocable. The final check asserts both the raw
 * `validateChannel` contract and that the surfaced first-run result carries the
 * fallback warning + a "(fallback)" completion message, then confirms the
 * default pack still seeded.
 *
 * Fail-without-fix anchor: `validateChannel` + the `ChannelInspector`
 * connectivity check (`src/lifeops/first-run/questions.ts`, header contract)
 * and `installFirstRunChannelInspector` (`.../first-run/channel-inspector.ts`).
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  channelFallbackRecorded,
  resetFirstRunPrecondition,
} from "./_helpers/first-run-onboarding.ts";

export default scenario({
  lane: "live-only",
  id: "first-run-channel-fallback-to-in-app",
  title: "First-run channel fallback: unconnected channel → in-app + warning",
  domain: "lifeops.first-run",
  tags: ["lifeops", "first-run", "onboarding", "channel", "mvp", "14353"],
  status: "active",
  tier: "T4",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "First open (channel choice)",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "reset first-run to fresh pending",
      apply: resetFirstRunPrecondition,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner asks to be nudged on an unconnected channel",
      text: "set me up, but send my nudges over Telegram — that's where i live.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "unconnected-channel-falls-back-with-warning",
      predicate: channelFallbackRecorded,
    },
  ],
});
