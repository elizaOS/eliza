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

const registeredAliases: Record<string, string[]> = {};
const rawToCanonical = new Map<string, string>();

function rebuildRawToCanonical(): void {
	rawToCanonical.clear();

	for (const [canonical, aliases] of Object.entries(CONNECTOR_SOURCE_ALIASES)) {
		for (const alias of aliases) {
			rawToCanonical.set(alias, canonical);
		}
	}

	for (const [canonical, aliases] of Object.entries(registeredAliases)) {
		for (const alias of aliases) {
			rawToCanonical.set(alias, canonical);
		}
	}
}

rebuildRawToCanonical();

export function registerConnectorSourceAliases(
	canonical: string,
	aliases: readonly string[],
): void {
	const key = canonical.trim().toLowerCase();
	if (!key) return;

	const existing = registeredAliases[key] ?? [];
	const merged = new Set([
		...existing,
		...aliases.map((alias) => alias.trim().toLowerCase()),
	]);
	registeredAliases[key] = Array.from(merged);
	rebuildRawToCanonical();
}

function getMergedAliases(canonical: string): readonly string[] {
	const hardcoded = CONNECTOR_SOURCE_ALIASES[canonical] ?? [];
	const registered = registeredAliases[canonical] ?? [];
	if (registered.length === 0) return hardcoded;
	return Array.from(new Set([...hardcoded, ...registered]));
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

	return rawToCanonical.get(trimmed) ?? trimmed;
}

export function getConnectorSourceAliases(
	source: string | null | undefined,
): string[] {
	const canonical = normalizeConnectorSource(source);
	if (!canonical) {
		return [];
	}

	const aliases = getMergedAliases(canonical);
	return [...(aliases.length > 0 ? aliases : [canonical])];
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
