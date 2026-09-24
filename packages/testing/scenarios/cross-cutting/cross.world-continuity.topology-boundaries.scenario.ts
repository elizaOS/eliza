/**
 * Deterministic cross-world topology boundary scenario. It proves that three
 * verified owner accounts converge on one principal while a same-name decoy
 * stays outside world/room discovery, and exercises query and invalid-id paths.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type MessageResult = {
  success?: boolean;
  data?: {
    error?: string;
    worlds?: Array<{ worldId: string; sources?: string[] }>;
    rooms?: Array<{ roomId: string; worldId: string; source?: string }>;
  };
};

function actionResult(
  ctx: ScenarioContext,
  action: string,
  expected: { query?: string; worldId?: string } = {},
): MessageResult | undefined {
  return ctx.actionsCalled.find((call) => {
    if (call.actionName !== "MESSAGE") return false;
    const captured = call.parameters as
      | { parameters?: Record<string, unknown> }
      | undefined;
    const parameters = captured?.parameters;
    return (
      parameters?.action === action &&
      parameters.query === expected.query &&
      parameters.worldId === expected.worldId
    );
  })?.result as MessageResult | undefined;
}

async function verifyTopologyBoundaries(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const allWorlds = actionResult(ctx, "list_worlds");
  const telegramWorlds = actionResult(ctx, "list_worlds", {
    query: "telegram",
  });
  const currentRooms = actionResult(ctx, "list_rooms");
  const invalidWorld = actionResult(ctx, "list_rooms", {
    worldId: "same-name-decoy",
  });
  if (!allWorlds?.success || allWorlds.data?.worlds?.length !== 3) {
    return `expected three authorized owner worlds, got ${allWorlds?.data?.worlds?.length ?? 0}`;
  }
  const authorizedSources = new Set(
    allWorlds.data.worlds.flatMap((world) => world.sources ?? []),
  );
  for (const source of ["discord", "telegram", "x"]) {
    if (!authorizedSources.has(source)) {
      return `missing authorized ${source} world`;
    }
  }
  const decoyWorldId = ctx.worldIds?.["discord-decoy-world"];
  if (
    decoyWorldId &&
    allWorlds.data.worlds.some((world) => world.worldId === decoyWorldId)
  ) {
    return "same-name decoy world leaked into owner discovery";
  }
  if (
    !telegramWorlds?.success ||
    telegramWorlds.data?.worlds?.length !== 1 ||
    !telegramWorlds.data.worlds[0]?.sources?.includes("telegram")
  ) {
    return "world query did not isolate the verified Telegram world";
  }
  const expectedRoomId = ctx.roomIds?.["x-owner-dm"];
  const expectedWorldId = ctx.worldIds?.["x-owner-world"];
  if (
    !currentRooms?.success ||
    currentRooms.data?.rooms?.length !== 1 ||
    currentRooms.data.rooms[0]?.roomId !== expectedRoomId ||
    currentRooms.data.rooms[0]?.worldId !== expectedWorldId
  ) {
    return "current-world room discovery returned the wrong room boundary";
  }
  if (
    invalidWorld?.success !== false ||
    invalidWorld.data?.error !== "INVALID_WORLD_ID"
  ) {
    return "invalid world id did not fail with INVALID_WORLD_ID";
  }

  const runtime = ctx.runtime as
    | {
        agentId: string;
        getService(type: string): {
          resolveCanonicalPrincipal(
            agentId: string,
            principalId: string,
          ): Promise<{ canonicalPrincipalId: string }>;
        } | null;
      }
    | undefined;
  const authority = runtime?.getService("principal");
  if (!runtime || !authority) return "principal authority was unavailable";
  const ownerAccounts = ["discord-owner", "telegram-owner", "x-owner"];
  const ownerPrincipals = ownerAccounts.map(
    (account) => ctx.accountEntityIds?.[account],
  );
  const decoyPrincipal = ctx.accountEntityIds?.["discord-same-name-decoy"];
  if (ownerPrincipals.some((principal) => !principal) || !decoyPrincipal) {
    return "scenario did not publish every connector principal";
  }
  const ownerCanonicalIds = await Promise.all(
    ownerPrincipals.map(async (principal) =>
      principal
        ? (
            await authority.resolveCanonicalPrincipal(
              runtime.agentId,
              principal,
            )
          ).canonicalPrincipalId
        : "",
    ),
  );
  if (new Set(ownerCanonicalIds).size !== 1) {
    return "verified owner connector principals did not converge";
  }
  const decoyCanonical = (
    await authority.resolveCanonicalPrincipal(runtime.agentId, decoyPrincipal)
  ).canonicalPrincipalId;
  if (ownerCanonicalIds.includes(decoyCanonical)) {
    return "same-name decoy was inferred into the verified identity cluster";
  }
  return undefined;
}

export default scenario({
  lane: "pr-deterministic",
  id: "cross.world-continuity.topology-boundaries",
  title: "Verified account topology excludes same-name worlds",
  domain: "cross-cutting",
  tags: ["identity", "cross-platform", "multi-world", "privacy"],
  description:
    "Discord, Telegram, and X owner accounts share one principal; an unrelated same-name Discord account cannot influence authorized world or room discovery.",
  isolation: "per-scenario",
  modelFixtures: {
    mode: "model-free",
    reason: "Every turn invokes the MESSAGE topology contract directly.",
  },
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "discord-owner-dm",
      world: "discord-owner-world",
      account: "discord-owner",
      entity: "canonical-owner",
      source: "discord",
      channelType: "DM",
      title: "Alex",
    },
    {
      id: "telegram-owner-dm",
      world: "telegram-owner-world",
      account: "telegram-owner",
      entity: "canonical-owner",
      source: "telegram",
      channelType: "DM",
      title: "Alex",
    },
    {
      id: "x-owner-dm",
      world: "x-owner-world",
      account: "x-owner",
      entity: "canonical-owner",
      source: "x",
      channelType: "DM",
      title: "Alex",
    },
    {
      id: "discord-decoy-dm",
      world: "discord-decoy-world",
      account: "discord-same-name-decoy",
      entity: "same-name-decoy",
      source: "discord",
      channelType: "DM",
      title: "Alex",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "all-owner-worlds",
      room: "x-owner-dm",
      actionName: "MESSAGE",
      text: "List all verified owner worlds.",
      options: { parameters: { action: "list_worlds" } },
      responseIncludes: ["discord", "telegram", "x"],
    },
    {
      kind: "action",
      name: "telegram-world-query",
      room: "x-owner-dm",
      actionName: "MESSAGE",
      text: "Find the Telegram world.",
      options: {
        parameters: { action: "list_worlds", query: "telegram" },
      },
      responseIncludes: ["telegram"],
    },
    {
      kind: "action",
      name: "current-world-rooms",
      room: "x-owner-dm",
      actionName: "MESSAGE",
      text: "List rooms in this world.",
      options: { parameters: { action: "list_rooms" } },
      responseIncludes: ["x-owner-dm"],
    },
    {
      kind: "action",
      name: "invalid-world-id",
      room: "x-owner-dm",
      actionName: "MESSAGE",
      text: "Reject an invalid world id.",
      options: {
        parameters: { action: "list_rooms", worldId: "same-name-decoy" },
      },
      responseIncludes: ["not a valid UUID"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "identity-and-topology-boundaries",
      predicate: verifyTopologyBoundaries,
    },
  ],
});
