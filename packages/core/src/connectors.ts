export type ConnectorSourceKind = "passive" | "active";

export interface ConnectorSourceMetadata {
	aliases?: readonly string[];
	sourceKind?: ConnectorSourceKind;
	isPassive?: boolean;
}

const CONNECTOR_SOURCE_METADATA: Record<string, ConnectorSourceMetadata> = {
	discord: {
		aliases: ["discord", "discord-local"],
		sourceKind: "passive",
		isPassive: true,
	},
	imessage: {
		aliases: ["imessage", "bluebubbles"],
		sourceKind: "passive",
		isPassive: true,
	},
	signal: { aliases: ["signal"], sourceKind: "passive", isPassive: true },
	slack: { aliases: ["slack"], sourceKind: "passive", isPassive: true },
	sms: { aliases: ["sms"], sourceKind: "passive", isPassive: true },
	telegram: {
		aliases: ["telegram", "telegram-account", "telegramaccount"],
		sourceKind: "passive",
		isPassive: true,
	},
	wechat: { aliases: ["wechat"], sourceKind: "passive", isPassive: true },
	whatsapp: { aliases: ["whatsapp"], sourceKind: "passive", isPassive: true },
	x: { aliases: ["x", "x_dm"], sourceKind: "passive", isPassive: true },
};

const registeredMetadata: Record<string, ConnectorSourceMetadata> = {};
const rawToCanonical = new Map<string, string>();

function mergeMetadata(
	base: ConnectorSourceMetadata | undefined,
	registered: ConnectorSourceMetadata | undefined,
): ConnectorSourceMetadata {
	return {
		aliases: Array.from(
			new Set([...(base?.aliases ?? []), ...(registered?.aliases ?? [])]),
		),
		sourceKind: registered?.sourceKind ?? base?.sourceKind,
		isPassive: registered?.isPassive ?? base?.isPassive,
	};
}

function getMergedMetadata(canonical: string): ConnectorSourceMetadata {
	return mergeMetadata(
		CONNECTOR_SOURCE_METADATA[canonical],
		registeredMetadata[canonical],
	);
}

function rebuildRawToCanonical(): void {
	rawToCanonical.clear();

	const canonicalSources = new Set([
		...Object.keys(CONNECTOR_SOURCE_METADATA),
		...Object.keys(registeredMetadata),
	]);
	for (const canonical of canonicalSources) {
		for (const alias of getMergedMetadata(canonical).aliases ?? [canonical]) {
			rawToCanonical.set(alias, canonical);
		}
	}
}

rebuildRawToCanonical();

export function registerConnectorSourceAliases(
	canonical: string,
	aliases: readonly string[],
): void {
	registerConnectorSourceMetadata(canonical, { aliases });
}

export function registerConnectorSourceMetadata(
	canonical: string,
	metadata: ConnectorSourceMetadata,
): void {
	const key = canonical.trim().toLowerCase();
	if (!key) return;

	const existing = registeredMetadata[key];
	const mergedAliases = new Set([
		...(existing?.aliases ?? []),
		...(metadata.aliases ?? []).map((alias) => alias.trim().toLowerCase()),
	]);
	registeredMetadata[key] = {
		...existing,
		...metadata,
		aliases: Array.from(mergedAliases),
	};
	rebuildRawToCanonical();
}

function getMergedAliases(canonical: string): readonly string[] {
	return getMergedMetadata(canonical).aliases ?? [];
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

export function getConnectorSourceMetadata(
	source: string | null | undefined,
): ConnectorSourceMetadata | null {
	const canonical = normalizeConnectorSource(source);
	if (!canonical) {
		return null;
	}
	const metadata = getMergedMetadata(canonical);
	return Object.keys(metadata).length > 0 ? metadata : null;
}

export function isPassiveConnectorSource(
	source: string | null | undefined,
): boolean {
	const metadata = getConnectorSourceMetadata(source);
	return Boolean(metadata?.isPassive || metadata?.sourceKind === "passive");
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
