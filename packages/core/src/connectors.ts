/**
 * Connector source registry: canonicalizes and classifies the `source` tag
 * carried on inbound messages (discord, telegram, farcaster, ...). Owners
 * register a canonical source with aliases and metadata (`sourceKind`
 * active/passive, `isPassive`); lookups normalize a raw source to its canonical
 * form, expand a source filter across all known aliases, and report whether a
 * source is passive.
 *
 * State is process-global and owner-scoped: registrations accumulate per owner
 * and merge on read, so plugins can contribute aliases without clobbering each
 * other, and an owner's contributions can be unregistered wholesale.
 */
export type ConnectorSourceKind = "passive" | "active";

export interface ConnectorSourceMetadata {
	aliases?: readonly string[];
	sourceKind?: ConnectorSourceKind;
	isPassive?: boolean;
}

export interface ConnectorSourceDefinition extends ConnectorSourceMetadata {
	source: string;
}

const DEFAULT_CONNECTOR_SOURCE_OWNER = "manual";

const registeredMetadataByOwner = new Map<
	string,
	Map<string, ConnectorSourceMetadata>
>();
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

function listRegisteredCanonicalSources(): string[] {
	const sources = new Set<string>();
	for (const ownerMetadata of registeredMetadataByOwner.values()) {
		for (const canonical of ownerMetadata.keys()) {
			sources.add(canonical);
		}
	}
	return [...sources];
}

function getMergedMetadata(canonical: string): ConnectorSourceMetadata {
	let merged: ConnectorSourceMetadata | undefined;
	for (const ownerMetadata of registeredMetadataByOwner.values()) {
		merged = mergeMetadata(merged, ownerMetadata.get(canonical));
	}
	return merged ?? {};
}

function rebuildRawToCanonical(): void {
	rawToCanonical.clear();

	for (const canonical of listRegisteredCanonicalSources()) {
		for (const alias of getMergedMetadata(canonical).aliases ?? [canonical]) {
			rawToCanonical.set(alias, canonical);
		}
	}
}

export function registerConnectorSourceAliases(
	canonical: string,
	aliases: readonly string[],
): void {
	registerConnectorSourceMetadata(canonical, { aliases });
}

export function registerConnectorSourceMetadata(
	canonical: string,
	metadata: ConnectorSourceMetadata,
	owner = DEFAULT_CONNECTOR_SOURCE_OWNER,
): void {
	const key = canonical.trim().toLowerCase();
	if (!key) return;

	const ownerKey = owner.trim() || DEFAULT_CONNECTOR_SOURCE_OWNER;
	let ownerMetadata = registeredMetadataByOwner.get(ownerKey);
	if (!ownerMetadata) {
		ownerMetadata = new Map();
		registeredMetadataByOwner.set(ownerKey, ownerMetadata);
	}

	const existing = ownerMetadata.get(key);
	const mergedAliases = new Set([
		key,
		...(existing?.aliases ?? []),
		...(metadata.aliases ?? []).map((alias) => alias.trim().toLowerCase()),
	]);
	ownerMetadata.set(key, {
		...existing,
		...metadata,
		aliases: Array.from(mergedAliases),
	});
	rebuildRawToCanonical();
}

export function registerConnectorSourceDefinitions(
	definitions: readonly ConnectorSourceDefinition[] | null | undefined,
	owner = DEFAULT_CONNECTOR_SOURCE_OWNER,
): void {
	for (const definition of definitions ?? []) {
		const { source, ...metadata } = definition;
		registerConnectorSourceMetadata(source, metadata, owner);
	}
}

export function unregisterConnectorSourceMetadataOwner(owner: string): void {
	const ownerKey = owner.trim();
	if (!ownerKey) return;
	registeredMetadataByOwner.delete(ownerKey);
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
