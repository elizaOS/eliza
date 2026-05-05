export interface ScapeSubactionDefinition {
  name: string;
  legacyAction: string;
  params: string;
  description: string;
}

export interface ScapeRouterDefinition {
  name: string;
  description: string;
  descriptionCompressed: string;
  subactions: readonly ScapeSubactionDefinition[];
}

export const SCAPE_ACTION_ROUTER_DEFINITIONS = [
  {
    name: "SCAPE_GAME",
    description:
      "Route xRSPS game actions for movement, chat, combat, inventory, and healing.",
    descriptionCompressed: "xRSPS game action router.",
    subactions: [
      {
        name: "walk_to",
        legacyAction: "WALK_TO",
        params: "x: N, z: N, run: true|false",
        description: "Walk to an absolute world tile.",
      },
      {
        name: "chat_public",
        legacyAction: "CHAT_PUBLIC",
        params: "message: text max 80 chars",
        description: "Say something in public chat.",
      },
      {
        name: "attack_npc",
        legacyAction: "ATTACK_NPC",
        params: "npcId: N",
        description: "Attack a nearby NPC by instance id.",
      },
      {
        name: "drop_item",
        legacyAction: "DROP_ITEM",
        params: "slot: 0-27",
        description: "Drop the item in an inventory slot.",
      },
      {
        name: "eat_food",
        legacyAction: "EAT_FOOD",
        params: "slot: 0-27 optional",
        description: "Eat food from an inventory slot or first edible item.",
      },
    ],
  },
  {
    name: "SCAPE_JOURNAL",
    description:
      "Route Scape Journal actions for goals and durable agent notes.",
    descriptionCompressed: "xRSPS journal action router.",
    subactions: [
      {
        name: "set_goal",
        legacyAction: "SET_GOAL",
        params: "title: text, notes: text optional",
        description: "Declare or update the active goal.",
      },
      {
        name: "complete_goal",
        legacyAction: "COMPLETE_GOAL",
        params: "status: completed|abandoned, notes: text optional",
        description: "Close the active goal.",
      },
      {
        name: "remember",
        legacyAction: "REMEMBER",
        params: "kind: note|lesson|landmark, text: note text, weight: 1-5",
        description: "Record a durable journal memory.",
      },
    ],
  },
] as const satisfies readonly ScapeRouterDefinition[];

export type ScapeRouterActionName =
  (typeof SCAPE_ACTION_ROUTER_DEFINITIONS)[number]["name"];

export interface ResolvedScapeAction {
  routerName: ScapeRouterActionName;
  subaction: string;
  legacyAction: string;
}

function normalizeActionName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
}

function normalizeSubactionName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

const RESOLVED_BY_ROUTER_AND_SUBACTION = new Map<string, ResolvedScapeAction>();
const RESOLVED_BY_LEGACY_ACTION = new Map<string, ResolvedScapeAction>();

for (const router of SCAPE_ACTION_ROUTER_DEFINITIONS) {
  for (const subaction of router.subactions) {
    const resolved: ResolvedScapeAction = {
      routerName: router.name as ScapeRouterActionName,
      subaction: subaction.name,
      legacyAction: subaction.legacyAction,
    };
    RESOLVED_BY_ROUTER_AND_SUBACTION.set(
      `${router.name}:${subaction.name}`,
      resolved,
    );
    RESOLVED_BY_LEGACY_ACTION.set(subaction.legacyAction, resolved);
  }
}

export function isScapeRouterActionName(actionName: unknown): boolean {
  const normalized = normalizeActionName(actionName);
  return SCAPE_ACTION_ROUTER_DEFINITIONS.some(
    (router) => router.name === normalized,
  );
}

export function resolveScapeRouterAction(
  actionName: unknown,
  subactionName?: unknown,
): ResolvedScapeAction | null {
  const normalizedAction = normalizeActionName(actionName);
  const normalizedSubaction = normalizeSubactionName(subactionName);

  if (normalizedSubaction) {
    const resolved = RESOLVED_BY_ROUTER_AND_SUBACTION.get(
      `${normalizedAction}:${normalizedSubaction}`,
    );
    if (resolved) return resolved;
  }

  return RESOLVED_BY_LEGACY_ACTION.get(normalizedAction) ?? null;
}

export function formatScapeRouterPrompt(): string {
  return SCAPE_ACTION_ROUTER_DEFINITIONS.map((router) => {
    const subactions = router.subactions
      .map(
        (subaction) =>
          `    - ${subaction.name}: ${subaction.params}; ${subaction.description}`,
      )
      .join("\n");
    return `  ${router.name}: choose subaction\n${subactions}`;
  }).join("\n");
}
