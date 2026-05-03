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

// ---------------------------------------------------------------------------
// Connector alias registry — allows plugins to register additional connector
// source aliases at runtime without modifying the hardcoded map above.
// ---------------------------------------------------------------------------

const _registeredAliases: Record<string, string[]> = {};

/**
 * Register additional connector source aliases at runtime.
 * Plugins should call this during initialization to add aliases for their
 * connector sources.
 *
 * @param canonical - The canonical connector name (e.g., "matrix")
 * @param aliases - Array of alias strings that should map to this canonical name
 */
export function registerConnectorSourceAliases(
  canonical: string,
  aliases: readonly string[],
): void {
  const key = canonical.trim().toLowerCase();
  if (!key) return;
  const existing = _registeredAliases[key] ?? [];
  const merged = new Set([
    ...existing,
    ...aliases.map((a) => a.trim().toLowerCase()),
  ]);
  _registeredAliases[key] = Array.from(merged);
  // Rebuild the lookup map to include new aliases
  _rebuildRawToCanonical();
}

const RAW_TO_CANONICAL = new Map<string, string>();

function _rebuildRawToCanonical(): void {
  RAW_TO_CANONICAL.clear();
  // Hardcoded aliases
  for (const [canonical, aliases] of Object.entries(CONNECTOR_SOURCE_ALIASES)) {
    for (const alias of aliases) {
      RAW_TO_CANONICAL.set(alias, canonical);
    }
  }
  // Runtime-registered aliases (override hardcoded on conflict)
  for (const [canonical, aliases] of Object.entries(_registeredAliases)) {
    for (const alias of aliases) {
      RAW_TO_CANONICAL.set(alias, canonical);
    }
  }
}

// Initial build from hardcoded aliases
_rebuildRawToCanonical();

/**
 * Get all connector source aliases for a given canonical name, merging
 * hardcoded and runtime-registered aliases.
 */
function _getMergedAliases(canonical: string): readonly string[] {
  const hardcoded = CONNECTOR_SOURCE_ALIASES[canonical] ?? [];
  const registered = _registeredAliases[canonical] ?? [];
  if (registered.length === 0) return hardcoded;
  const merged = new Set([...hardcoded, ...registered]);
  return Array.from(merged);
}

export function normalizeConnectorSource(
  source: string | null | undefined,
): string {
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

  return [
    ...(_getMergedAliases(canonical).length > 0
      ? _getMergedAliases(canonical)
      : [canonical]),
  ];
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
