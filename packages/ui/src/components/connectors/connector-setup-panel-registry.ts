import { getBootConfig } from "../../config/boot-config";

/**
 * Registry that resolves a connector setup-plugin id to the token of the
 * built-in setup panel that renders it. This replaces the per-connector-id
 * `switch` that used to live in both `ConnectorSetupPanel.helpers.ts`
 * (`hasConnectorSetupPanel`) and `ConnectorSetupPanel.tsx` (component render).
 *
 * Keeping the id → token rules in one pure module (no React) lets the boolean
 * `hasConnectorSetupPanel` check and the component render share a single source
 * of truth instead of two parallel switches that had to be kept in sync.
 *
 * Matching preserves the historical semantics exactly:
 *  - `exact`: the normalized id equals the needle (the old `switch` cases).
 *  - `substring`: the normalized id contains the needle (the old `.includes`
 *    checks that catch namespaced plugin ids such as
 *    `@elizaos/plugin-telegram` → `elizaosplugintelegram`).
 * Rules are evaluated in registration order; the first match wins.
 *
 * A rule may carry an optional `available` predicate for panels whose backing
 * component is supplied at runtime rather than statically bundled (e.g. the
 * host-provided LifeOps browser-bridge panel). When present, the rule only
 * matches while the predicate returns true — this is what keeps the boolean
 * `hasConnectorSetupPanel` gate connector-id-free in the helper: the id → panel
 * knowledge (including its availability condition) lives entirely in this
 * registry, not in a per-connector branch in `ConnectorSetupPanel.helpers.ts`.
 */
export type ConnectorSetupPanelToken =
  | "telegram-account"
  | "telegram-bot"
  | "whatsapp"
  | "signal"
  | "discord-local"
  | "bluebubbles"
  | "imessage"
  | "lifeops-browser";

type MatchKind = "exact" | "substring";

interface ConnectorSetupPanelRule {
  token: ConnectorSetupPanelToken;
  needle: string;
  match: MatchKind;
  /**
   * Optional gate for runtime-provided panels. When set, the rule only resolves
   * while it returns true; omitted for statically bundled panels (always on).
   */
  available?: () => boolean;
}

const rules: ConnectorSetupPanelRule[] = [];

export function registerConnectorSetupPanelRule(
  rule: ConnectorSetupPanelRule,
): void {
  rules.push(rule);
}

/**
 * Resolve a normalized plugin id to a built-in setup-panel token, or `null`
 * when no built-in panel handles it.
 */
export function resolveConnectorSetupPanelToken(
  normalizedId: string,
): ConnectorSetupPanelToken | null {
  for (const rule of rules) {
    const matched =
      rule.match === "exact"
        ? normalizedId === rule.needle
        : normalizedId.includes(rule.needle);
    if (matched && (rule.available?.() ?? true)) return rule.token;
  }
  return null;
}

// Built-in rules. Order mirrors the previous `hasConnectorSetupPanel`
// evaluation order (telegram-account and namespaced telegram bot ids before
// the exact switch cases).
registerConnectorSetupPanelRule({
  token: "telegram-account",
  needle: "telegramaccount",
  match: "substring",
});
registerConnectorSetupPanelRule({
  token: "telegram-bot",
  needle: "plugintelegram",
  match: "substring",
});
registerConnectorSetupPanelRule({
  token: "telegram-bot",
  needle: "telegram",
  match: "exact",
});
registerConnectorSetupPanelRule({
  token: "whatsapp",
  needle: "whatsapp",
  match: "exact",
});
registerConnectorSetupPanelRule({
  token: "signal",
  needle: "signal",
  match: "exact",
});
registerConnectorSetupPanelRule({
  token: "discord-local",
  needle: "discordlocal",
  match: "exact",
});
registerConnectorSetupPanelRule({
  token: "bluebubbles",
  needle: "bluebubbles",
  match: "exact",
});
registerConnectorSetupPanelRule({
  token: "imessage",
  needle: "imessage",
  match: "exact",
});

// The LifeOps browser-bridge panel is a host-provided component (boot-config
// slot), not a statically bundled one, so its rule only resolves while the host
// has supplied it. Both namespaced (`lifeopsbrowser`) and short (`browserbridg`)
// connector ids route to it — matching the ids the previous helper branch tested.
registerConnectorSetupPanelRule({
  token: "lifeops-browser",
  needle: "lifeopsbrowser",
  match: "substring",
  available: () => Boolean(getBootConfig().lifeOpsBrowserSetupPanel),
});
registerConnectorSetupPanelRule({
  token: "lifeops-browser",
  needle: "browserbridg",
  match: "substring",
  available: () => Boolean(getBootConfig().lifeOpsBrowserSetupPanel),
});
