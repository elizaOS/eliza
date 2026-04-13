const CONNECTOR_SOURCE_ALIASES: Record<string, readonly string[]> = {
  discord: ["discord", "discord-local"],
  imessage: ["imessage", "bluebubbles"],
  signal: ["signal"],
  slack: ["slack"],
  sms: ["sms"],
  telegram: ["telegram", "telegram-account", "telegramaccount"],
  wechat: ["wechat"],
  whatsapp: ["whatsapp"],
};

const RAW_TO_CANONICAL = new Map<string, string>();

for (const [canonical, aliases] of Object.entries(CONNECTOR_SOURCE_ALIASES)) {
  for (const alias of aliases) {
    RAW_TO_CANONICAL.set(alias, canonical);
  }
}

export function normalizeConnectorSource(source: string | null | undefined): string {
  if (typeof source !== "string") {
    return "";
  }

  const trimmed = source.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  return RAW_TO_CANONICAL.get(trimmed) ?? trimmed;
}

export function getConnectorSourceAliases(
  source: string | null | undefined,
): string[] {
  const canonical = normalizeConnectorSource(source);
  if (!canonical) {
    return [];
  }

  return [...(CONNECTOR_SOURCE_ALIASES[canonical] ?? [canonical])];
}

export function expandConnectorSourceFilter(
  sources: Iterable<string> | null | undefined,
): Set<string> {
  const expanded = new Set<string>();

  for (const source of sources ?? []) {
    for (const alias of getConnectorSourceAliases(source)) {
      expanded.add(alias);
    }
  }

  return expanded;
}
