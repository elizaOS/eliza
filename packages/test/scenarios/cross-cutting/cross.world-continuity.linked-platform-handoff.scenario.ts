/**
 * Live-model continuity scenario across three connector accounts and worlds.
 * It verifies automatic recent-context handoff and explicit durable topology
 * discovery for one canonical owner using Discord, Telegram, and X.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

function verifyTopologyDiscovery(ctx: ScenarioContext): string | undefined {
  const discovery = ctx.actionsCalled.find((call) => {
    if (call.actionName !== "MESSAGE") return false;
    const captured = call.parameters as
      | { parameters?: Record<string, unknown> }
      | undefined;
    return captured?.parameters?.action === "list_worlds";
  });
  if (!discovery) return "expected MESSAGE action=list_worlds";
  if (discovery.result?.success !== true) {
    return "expected list_worlds to succeed";
  }
  const data = discovery.result.data as
    | { worlds?: Array<{ sources?: string[] }> }
    | undefined;
  if (data?.worlds?.length !== 3) {
    return `expected exactly three authorized worlds, got ${data?.worlds?.length ?? 0}`;
  }
  const sources = new Set(data.worlds.flatMap((world) => world.sources ?? []));
  for (const source of ["discord", "telegram", "x"]) {
    if (!sources.has(source)) return `expected an authorized ${source} world`;
  }
  if (new Set(Object.values(ctx.worldIds ?? {})).size !== 3) {
    return "scenario topology did not create three distinct worlds";
  }
  if (new Set(Object.values(ctx.accountEntityIds ?? {})).size !== 1) {
    return "linked connector accounts did not resolve to one canonical entity";
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "cross.world-continuity.linked-platform-handoff",
  title: "Linked owner hands context across Discord, Telegram, and X",
  domain: "cross-cutting",
  tags: ["identity", "cross-platform", "multi-world", "memory"],
  description:
    "One verified owner supplies a fact in Discord, recalls it in Telegram, then discovers the durable worlds shared with the agent from X.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "discord-dm",
      world: "discord-guild-alpha",
      account: "discord-owner",
      entity: "canonical-owner",
      source: "discord",
      channelType: "DM",
      title: "Discord owner DM",
    },
    {
      id: "telegram-dm",
      world: "telegram-private",
      account: "telegram-owner",
      entity: "canonical-owner",
      source: "telegram",
      channelType: "DM",
      title: "Telegram owner DM",
    },
    {
      id: "x-dm",
      world: "x-private",
      account: "x-owner",
      entity: "canonical-owner",
      source: "x",
      channelType: "DM",
      title: "X owner DM",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "discord-establishes-context",
      room: "discord-dm",
      text: "Remember this exact handoff detail: launch code ORCHID-742 and the red prototype is in locker 19.",
    },
    {
      kind: "message",
      name: "telegram-recalls-discord-context",
      room: "telegram-dm",
      text: "What launch code and locker did I tell you in another world?",
      responseIncludes: ["ORCHID-742", "19"],
      responseJudge: {
        minimumScore: 0.9,
        rubric:
          "The reply must correctly recover both ORCHID-742 and locker 19 from the prior Discord turn. Guessing, asking the user to repeat it, or omitting either detail fails.",
      },
    },
    {
      kind: "message",
      name: "x-discovers-shared-worlds",
      room: "x-dm",
      text: "Use your durable topology to list every world we share. Call MESSAGE with action list_worlds.",
      expectedActions: ["MESSAGE"],
      responseIncludesAny: ["Discord", "Telegram", "X", "world"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "authorized-three-world-topology",
      predicate: verifyTopologyDiscovery,
    },
  ],
});
