/** Scenario fixture for selfcontrol integration with todos auto block; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { expectNoActionCalled } from "@elizaos/scenario-runner/scenario-assertions";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

function expectClarificationBeforeTodoBlock(
  ctx: ScenarioContext,
): string | undefined {
  const forbidden = expectNoActionCalled(ctx, ["WEBSITE_BLOCK"]);
  if (forbidden) return forbidden;

  const reply = ctx.turns?.at(-1)?.responseText ?? "";
  if (!/(which|what|specific|site|social|\?)/i.test(reply)) {
    return `expected clarification for unspecified social sites before creating a todo-gated block, saw ${JSON.stringify(reply)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "selfcontrol.integration-with-todos.auto-block",
  title: "Todo-gated social block asks for specific sites",
  domain: "selfcontrol",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "selfcontrol", "clarification", "todo-gated"],
  description:
    "A todo-gated auto-block request without explicit websites should ask which social sites to include before the rule is created.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Auto-Block From Todos",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "set-rule",
      room: "main",
      text: "Auto-block socials if my workout isn't done by noon.",
      forbiddenActions: ["WEBSITE_BLOCK"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "todo-gated-block-asks-for-sites-before-side-effect",
      predicate: expectClarificationBeforeTodoBlock,
    },
  ],
});
