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

import { readFileSync } from "node:fs";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  productionAgentSettingsSeed,
  seededElizaConfigPath,
} from "./_helpers/production-agent-seeds";

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
  // The lean scenario runtime registers only app-control's SETTINGS action,
  // which by design disclaims provider switching ("switching the model is
  // MODEL_SWITCH") — a live model correctly refuses to route this request
  // through it. Production wins the SETTINGS name collision with the
  // agent-level action (update_ai_provider op); seed that real action so the
  // runtime under test matches production (#16939).
  seed: [productionAgentSettingsSeed()],
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
    {
      // Domain artifact: the switch actually landed in the (seed-isolated)
      // eliza.json config store — the same shape the deterministic op suite
      // (settings-chat-config-ops.test.ts) pins — not a fabricated success.
      type: "custom",
      name: "provider switch persisted to the isolated eliza.json",
      predicate: async () => {
        const configPath = seededElizaConfigPath();
        if (!configPath) {
          return "seed did not run: no isolated config path recorded";
        }
        const config = JSON.parse(readFileSync(configPath, "utf8")) as {
          serviceRouting?: { llmText?: { backend?: string } };
          agents?: { defaults?: { model?: { primary?: string } } };
        };
        const backend = config.serviceRouting?.llmText?.backend;
        if (backend !== "openai") {
          return `serviceRouting.llmText.backend is ${JSON.stringify(backend)}, expected "openai" (config: ${JSON.stringify(config).slice(0, 400)})`;
        }
        const primary = config.agents?.defaults?.model?.primary;
        if (primary !== "@elizaos/plugin-openai") {
          return `agents.defaults.model.primary is ${JSON.stringify(primary)}, expected "@elizaos/plugin-openai"`;
        }
        return undefined;
      },
    },
  ],
});
