/**
 * Live-model [CONFIG] emission (#14322). When the user names a plugin for
 * setup, the uiWidgets guide instructs the model to emit EXACTLY
 * `[CONFIG:pluginId]` and stop — the dashboard generates the full config form
 * from the plugin schema. This proves a real model, given the production
 * guide, replies with the marker instead of hand-writing credential steps or
 * falling back to generative-UI JSONL patches.
 *
 * The named plugin is polymarket (one of the guide's own examples), NOT
 * discord: the scenario harness boots mocked connectors, so "set up discord"
 * routes to CONNECTOR_CONNECT which SUCCEEDS against the mock and the agent
 * truthfully replies "Discord is set up and connected as mocked_owner#0001" —
 * asserting a config card there would assert the wrong behavior for that
 * environment (captured live in evidence-14322/config-report.json). Polymarket
 * has no connector/action in the scenario runtime, so the marker path is the
 * only correct answer. Needs live model credentials (live-only lane).
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { uiWidgetsGuideSeed } from "./_helpers/chat-widgets";

export default scenario({
  id: "live-chat-widgets-config-emission",
  lane: "live-only",
  title:
    "Real LLM answers 'set up polymarket' with [CONFIG:polymarket], no prose walkthrough",
  domain: "chat-widgets",
  tags: ["live", "real-llm", "chat-widgets", "config"],
  isolation: "per-scenario",
  seed: [uiWidgetsGuideSeed()],
  rooms: [
    {
      id: "main",
      source: "eliza-app",
      title: "Chat Widgets Config",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "plugin-setup request must emit the [CONFIG:polymarket] marker",
      room: "main",
      text: "Help me set up the polymarket plugin.",
      responseIncludesAny: [/\[CONFIG:(@elizaos\/plugin-)?polymarket\]/i],
      // No generative-UI escape hatch: a JSONL patch line in a plugin-setup
      // reply means the model reached for the wrong tool (the guide's marker
      // path exists precisely to keep setup off raw JSONL).
      responseExcludes: [/"op"\s*:\s*"(add|replace|remove)"/],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The user asked to set up the polymarket plugin. The reply must present " +
          "the configuration via the [CONFIG:polymarket] marker (the UI renders the " +
          "actual form). It must NOT walk the user through manual setup steps in " +
          "prose — no instructions to find/copy API keys or paste credentials into " +
          "config files. A short sentence introducing the config card is fine.",
      },
    },
  ],
});
