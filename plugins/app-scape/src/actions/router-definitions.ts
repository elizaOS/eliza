/**
 * Router definitions for `@elizaos/app-scape`.
 *
 * Two compressed routers reduce planner-context cost by collapsing
 * journal and inventory verbs that share the same shape:
 *
 *   - JOURNAL_OP: set-goal, complete-goal, remember
 *   - INVENTORY_OP: eat, drop
 *
 * The remaining verbs (SCAPE_WALK_TO, ATTACK_NPC, CHAT_PUBLIC) stay as
 * standalone actions because their parameter shapes do not overlap.
 */

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
    name: "JOURNAL",
    description:
      "Route Scape Journal operations for goals and durable agent notes.",
    descriptionCompressed: "Journal ops: set-goal, complete-goal, remember.",
    subactions: [
      {
        name: "set-goal",
        legacyAction: "SET_GOAL",
        params: "title: text, notes: text optional",
        description: "Declare or update the active goal.",
      },
      {
        name: "complete-goal",
        legacyAction: "COMPLETE_GOAL",
        params:
          "status: completed|abandoned, goalId: text optional, notes: text optional",
        description: "Close the active goal.",
      },
      {
        name: "remember",
        legacyAction: "REMEMBER",
        params: "kind: note|lesson|landmark, notes: note text, weight: 1-5",
        description: "Record a durable journal memory.",
      },
    ],
  },
  {
    name: "INVENTORY",
    description:
      "Route inventory operations for eating food and dropping items.",
    descriptionCompressed: "Inventory ops: eat, drop.",
    subactions: [
      {
        name: "eat",
        legacyAction: "EAT_FOOD",
        params: "item: 0-27 optional",
        description: "Eat food from an inventory slot or first edible item.",
      },
      {
        name: "drop",
        legacyAction: "DROP_ITEM",
        params: "item: 0-27",
        description: "Drop the item in an inventory slot.",
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
    .replace(/[\s_]+/g, "-")
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
    return `  ${router.name}: choose op\n${subactions}`;
  }).join("\n");
}
