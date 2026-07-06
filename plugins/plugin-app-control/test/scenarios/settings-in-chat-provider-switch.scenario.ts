/**
 * Live-model leg of #14325: a natural in-chat "switch my model provider to
 * openai" request must select the owner-gated SETTINGS action and drive its
 * `update_ai_provider` op — proving the chat surface can mutate app-level
 * settings, not just render a card. The persistence of that op to the real
 * eliza.json store (serviceRouting.llmText.backend = openai, provider env) is
 * proven deterministically in
 * `packages/agent/src/actions/settings-chat-config-ops.test.ts`; this scenario
 * proves the live model routes the natural request to SETTINGS with the right
 * op + provider argument, which the deterministic proxy cannot (it never plans).
 *
 * Note: the app-level SETTINGS action is
 * `packages/agent/src/actions/settings-actions.ts` (ops: update_ai_provider,
 * toggle_capability, set_owner_name, set, backends). PR #14461 consolidated the
 * app-control SETTINGS action separately; this scenario asserts by action name
 * (`SETTINGS`) plus the `update_ai_provider` op argument, which survives that
 * consolidation.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "settings-in-chat-provider-switch",
  title: "SETTINGS action switches the model provider from a chat request",
  domain: "app-control",
  tags: ["app-control", "settings", "chat-widgets", "provider", "14325"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  rooms: [
    {
      id: "main",
      source: "chat",
      title: "Settings In Chat — Provider Switch",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner-asks-switch-provider",
      text: "Switch my model provider to openai.",
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "SETTINGS",
    },
    {
      type: "actionCalled",
      actionName: "SETTINGS",
      status: "success",
      minCount: 1,
    },
    {
      // The op discriminator + provider must reach the handler; without this the
      // model could pick SETTINGS but with the wrong op and still look green.
      type: "selectedActionArguments",
      actionName: "SETTINGS",
      includesAll: [/update_ai_provider/i, /openai/i],
    },
  ],
});
