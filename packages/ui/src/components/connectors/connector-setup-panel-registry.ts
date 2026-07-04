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
 */
export type ConnectorSetupPanelToken =
  | "telegram-account"
  | "telegram-bot"
  | "whatsapp"
  | "signal"
  | "discord-local"
  | "bluebubbles"
  | "imessage";

type MatchKind = "exact" | "substring";

interface ConnectorSetupPanelRule {
  token: ConnectorSetupPanelToken;
  needle: string;
  match: MatchKind;
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
    if (matched) return rule.token;
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
