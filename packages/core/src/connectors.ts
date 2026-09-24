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

/**
 * Declares how a connector projects the flat identity fields it stamps on a
 * Memory's top-level metadata into the nested `metadata[source]` identity object
 * that role resolution consumes (`{ userId, id, name, username }`). Owning this
 * mapping on the connector's registered source metadata is what lets core stop
 * special-casing individual connectors (e.g. Discord's `fromId`/`entityName`)
 * inside `roles.ts` — the projection lives with the connector, not in a trunk
 * `source === "discord"` branch (#12090 item 22 / #12087).
 */
export interface ConnectorIdentityMetadataMapping {
	/** Flat metadata key holding the stable platform user id (maps to `userId` + `id`). */
	userIdField: string;
	/** Optional flat metadata key holding a display/handle (maps to `name` + `username`). */
	nameField?: string;
}

export interface ConnectorSourceMetadata {
	aliases?: readonly string[];
	sourceKind?: ConnectorSourceKind;
	isPassive?: boolean;
	/**
	 * How this connector's flat Memory metadata fields project into the nested
	 * `metadata[source]` identity object used by role resolution. When present,
	 * core reads identity from the declared fields instead of a connector-specific
	 * literal branch.
	 */
	identityMetadataMapping?: ConnectorIdentityMetadataMapping;
	/**
	 * Ordered list of flat Memory metadata keys this connector uses to derive a
	 * world id (first present, non-empty string wins). Replaces connector-specific
	 * literals like `discordServerId`/`discordChannelId` in core.
	 */
	worldIdMetadataKeys?: readonly string[];
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
		identityMetadataMapping:
			registered?.identityMetadataMapping ?? base?.identityMetadataMapping,
		worldIdMetadataKeys:
			registered?.worldIdMetadataKeys ?? base?.worldIdMetadataKeys,
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

/**
 * The declared flat-field → nested-identity projection for a connector source,
 * or `null` if the connector registered none. Lets core read a connector's
 * identity mapping from the registry instead of a `source === "..."` literal.
 */
export function getConnectorIdentityMetadataMapping(
	source: string | null | undefined,
): ConnectorIdentityMetadataMapping | null {
	const metadata = getConnectorSourceMetadata(source);
	const mapping = metadata?.identityMetadataMapping;
	if (!mapping || typeof mapping.userIdField !== "string") {
		return null;
	}
	const userIdField = mapping.userIdField.trim();
	if (!userIdField) {
		return null;
	}
	const nameField =
		typeof mapping.nameField === "string" && mapping.nameField.trim()
			? mapping.nameField.trim()
			: undefined;
	return { userIdField, ...(nameField ? { nameField } : {}) };
}

/**
 * The ordered flat metadata keys a connector uses to derive a world id, or an
 * empty array if none were declared. Replaces connector-specific world-id
 * literals in core.
 */
export function getConnectorWorldIdMetadataKeys(
	source: string | null | undefined,
): string[] {
	const metadata = getConnectorSourceMetadata(source);
	const keys = metadata?.worldIdMetadataKeys;
	if (!Array.isArray(keys)) {
		return [];
	}
	return keys
		.filter((key): key is string => typeof key === "string")
		.map((key) => key.trim())
		.filter((key) => key.length > 0);
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

/**
 * Owner key for the built-in, legacy Discord connector-source metadata registered
 * below. The Discord plugin lives outside this monorepo, so the flat-field →
 * identity / world-id projection it needs is registered here as an explicit,
 * grep-able legacy default instead of remaining as `source === "discord"`
 * literal branches inside core's `roles.ts` (#12090 item 22 / #12087). When the
 * Discord plugin registers its own `connectorSources` mapping at runtime, that
 * owner-scoped registration merges over this default (registered metadata wins in
 * {@link mergeMetadata}); this default only backstops back-compat.
 */
export const LEGACY_DISCORD_CONNECTOR_SOURCE_OWNER =
	"core:legacy-discord-metadata";

/**
 * The Discord identity/world-id field projection previously hardcoded in
 * `roles.ts`. Declared here as connector-owned registry metadata so core reads it
 * generically. `fromId`/`entityName` were the flat Memory metadata keys Discord
 * stamps; `discordServerId`/`discordChannelId` were the world-id derivation keys.
 */
export const LEGACY_DISCORD_CONNECTOR_SOURCE_METADATA: ConnectorSourceMetadata =
	{
		identityMetadataMapping: {
			userIdField: "fromId",
			nameField: "entityName",
		},
		worldIdMetadataKeys: ["discordServerId", "discordChannelId"],
	};

registerConnectorSourceMetadata(
	"discord",
	LEGACY_DISCORD_CONNECTOR_SOURCE_METADATA,
	LEGACY_DISCORD_CONNECTOR_SOURCE_OWNER,
);
