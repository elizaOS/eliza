/**
 * Corpus-wide pseudonym consistency for the PII scrub pipeline (#14805).
 *
 * Chunk-local scrubbing produces inconsistent pseudonyms: "John Smith" in a
 * document becomes one surrogate, "Johnny" in a chat room another, "@jsmith" in
 * a transcript mirror survives untouched — the corpus stays linkable and
 * partially unscrubbed. This module owns the fix: **one real-world person — all
 * aliases, nicknames, platform handles — maps to exactly ONE pseudonym across
 * the entire corpus** (text, transcript fragments, and audio-redaction span
 * labels alike).
 *
 * Design points (issue #14805, followed exactly):
 *
 * - **Keyed by entity cluster, not by surface string.** The unit of identity is
 *   a `clusterId` — the caller derives it from the resolved entity (the
 *   `EntityStore` alias backbone, `packages/agent/src/services/knowledge-graph/
 *   entity-store.ts`) or its own clustering. Two distinct people who share a
 *   name are two clusters and get two different pseudonyms; identity merges
 *   keep going through the merge engine, never through this map.
 * - **Surrogate generation seeds from the session pseudonymizer**
 *   ({@link mintSurrogate} in `./pii-pseudonymizer.ts`), extended from
 *   per-session to corpus-persistent: the mint seed is
 *   `(salt, kind, clusterId, attempt)`, so the same cluster deterministically
 *   re-mints the same pseudonym under the same map salt, and the salt is
 *   persisted inside the (secret) snapshot so re-runs are stable.
 * - **The map itself is a secret artifact.** The alias→pseudonym map inverts
 *   the scrub. This class only holds it in memory; persistence goes through a
 *   {@link ./pii-pseudonym-map-store | protected store} that lives OUTSIDE the
 *   retrievable corpus (never a document/memory row, never embedded, never
 *   indexed). Slices handed to a model are {@link PiiPseudonymAssignment}s —
 *   `{entityClusterId, surrogate, kind}` only, never a real alias, and only
 *   for clusters relevant to the chunk at hand.
 * - **Ambiguity is escalated, never guessed.** An alias claimed by two or more
 *   clusters ("John" could be either person) is never blind-substituted; it is
 *   reported as ambiguous so the LLM-pass judges it with the context pack
 *   attached ({@link ./pii-context-pack}).
 *
 * Ruleset interplay: the map records the ruleset version a cluster was first
 * assigned and last touched under, but the pseudonym is STABLE across ruleset
 * bumps — a `v<rulesetVersion>` bump re-scrubs content (the content-hash
 * done-marker `pii:<sha256>:v<ruleset>` no longer matches,
 * `./pii-scrub-markers.ts`) with the SAME pseudonyms, so a re-scrub never
 * re-links or re-shuffles identities.
 */

import type { PiiPseudonymAssignment } from "../types/model.js";
import {
	compileReplacer,
	DEFAULT_PSEUDONYM_BLOCKLIST,
	mintSurrogate,
} from "./pii-pseudonymizer.js";

/** One platform identity claim attached to a cluster (`{platform, handle}`). */
export interface PseudonymClusterIdentity {
	readonly platform: string;
	readonly handle: string;
}

/**
 * One persisted cluster of the corpus pseudonym map:
 * `{clusterId → pseudonym, aliases[], identities[], evidence[], firstSeen,
 * rulesetVersion}` (the issue's map shape). `supersededPseudonyms` is the audit
 * trail of pseudonyms this cluster previously held — non-empty only after a
 * re-mint (a newly learned real alias collided with the old pseudonym), so the
 * write-back stage can repair artifacts written under the old value.
 */
export interface PseudonymClusterRecord {
	/** Stable cluster id (e.g. `entity:<entityId>` from the EntityStore). */
	readonly clusterId: string;
	/** Canonical entity class (`person`, `org`, `location`, …). */
	readonly kind: string;
	/** The single corpus-wide replacement for every alias of this cluster. */
	readonly pseudonym: string;
	/** Every observed surface form (full name, nickname, @handle, …). */
	readonly aliases: readonly string[];
	/** Platform identity claims linking the aliases to one person. */
	readonly identities: readonly PseudonymClusterIdentity[];
	/** Why the caller believes these aliases co-refer (audit only). */
	readonly evidence: readonly string[];
	/** Unix ms this cluster was first assigned. */
	readonly firstSeen: number;
	/** Ruleset version of the most recent assignment touching this cluster. */
	readonly rulesetVersion: string;
	/** Pseudonyms this cluster previously held (re-mint audit trail). */
	readonly supersededPseudonyms: readonly string[];
}

/** Serializable snapshot of the whole map — the SECRET artifact. */
export interface PseudonymMapSnapshot {
	readonly version: 1;
	/** The mint salt. Secret: with it (plus cluster ids) the mapping re-derives. */
	readonly salt: string;
	readonly clusters: readonly PseudonymClusterRecord[];
}

/** Input to {@link CorpusPseudonymMap.assign} — one upsert of cluster facts. */
export interface AssignClusterInput {
	/**
	 * Stable cluster id. REQUIRED: the map never invents identity — the caller
	 * resolves who-is-who through the entity backbone / merge engine and hands
	 * the resulting stable id in.
	 */
	readonly clusterId: string;
	/** Entity class; used to shape the pseudonym (`person`, `org`, …). */
	readonly kind: string;
	/** Surface forms observed for this cluster (idempotently unioned). */
	readonly aliases: readonly string[];
	/** Platform identities (idempotently unioned; one identity = one cluster). */
	readonly identities?: readonly PseudonymClusterIdentity[];
	/** Evidence strings (idempotently unioned, audit only). */
	readonly evidence?: readonly string[];
	/** The active ruleset version this assignment happens under. */
	readonly rulesetVersion: string;
}

/** Result of {@link CorpusPseudonymMap.substituteAliases}. */
export interface AliasSubstitutionResult {
	/** The text with every unambiguous alias replaced by its cluster pseudonym. */
	readonly text: string;
	/** Assignment slice for every cluster that was actually applied. */
	readonly applied: readonly PiiPseudonymAssignment[];
	/**
	 * Aliases present in the text that are claimed by 2+ clusters. NOT
	 * substituted — ambiguity is escalated to the model with context, never
	 * guessed (a wrong guess links two people).
	 */
	readonly ambiguous: readonly string[];
}

export interface CorpusPseudonymMapOptions {
	/**
	 * Deterministic mint salt. Omit to generate a cryptographically random one
	 * (persisted in the snapshot so the corpus mapping stays stable across
	 * runs while remaining unlinkable across corpora).
	 */
	readonly salt?: string;
	/**
	 * Values never treated as aliases (merged with
	 * {@link DEFAULT_PSEUDONYM_BLOCKLIST}). Compared case-insensitively.
	 */
	readonly blocklist?: Iterable<string>;
	/** Minimum trimmed alias length (guards stopword spans). Default 2. */
	readonly minAliasLength?: number;
	/** Clock override for tests. */
	readonly now?: () => number;
}

/** Thrown when the map refuses an operation that would corrupt identity. */
export class PseudonymMapIntegrityError extends Error {
	constructor(message: string) {
		super(`Corpus pseudonym map integrity violation: ${message}`);
		this.name = "PseudonymMapIntegrityError";
	}
}

function randomSalt(): string {
	const bytes = new Uint8Array(16);
	const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
	if (typeof cryptoObj?.getRandomValues === "function") {
		cryptoObj.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i += 1) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function identityKey(identity: PseudonymClusterIdentity): string {
	return `${identity.platform.trim().toLowerCase()}\0${identity.handle
		.trim()
		.toLowerCase()}`;
}

/** Mutable working shape of a cluster while the map is live. */
interface ClusterState {
	readonly clusterId: string;
	readonly kind: string;
	pseudonym: string;
	aliases: string[];
	identities: PseudonymClusterIdentity[];
	evidence: string[];
	firstSeen: number;
	rulesetVersion: string;
	supersededPseudonyms: string[];
}

/**
 * The corpus-persistent pseudonym map: cluster-keyed, deterministic,
 * collision-safe, idempotent. See the module doc for the contract. Not
 * thread-safe; the scrub pipeline runs it on the single-drain task rails.
 */
export class CorpusPseudonymMap {
	private readonly salt: string;
	private readonly blocklistLower: ReadonlySet<string>;
	private readonly minAliasLength: number;
	private readonly now: () => number;

	private readonly clusters = new Map<string, ClusterState>();
	/** alias (lowercased) → owning cluster ids. Size > 1 marks ambiguity. */
	private readonly aliasOwners = new Map<string, Set<string>>();
	/** identity key → owning cluster id (unique — see {@link assign}). */
	private readonly identityOwner = new Map<string, string>();
	/** All pseudonyms in use, lowercased, for O(1) mint collision checks. */
	private readonly pseudonymsLower = new Map<string, string>();

	constructor(options: CorpusPseudonymMapOptions = {}) {
		this.salt = options.salt ?? randomSalt();
		this.blocklistLower = new Set(
			[...DEFAULT_PSEUDONYM_BLOCKLIST, ...(options.blocklist ?? [])]
				.map((v) => v.trim().toLowerCase())
				.filter(Boolean),
		);
		this.minAliasLength = options.minAliasLength ?? 2;
		this.now = options.now ?? Date.now;
	}

	/** Number of clusters in the map. */
	get size(): number {
		return this.clusters.size;
	}

	/** Immutable view of every cluster record (audit/persistence). */
	get records(): PseudonymClusterRecord[] {
		return [...this.clusters.values()].map((c) => toRecord(c));
	}

	/**
	 * Upsert cluster facts. Idempotent: re-assigning the same cluster (in any
	 * order, across any number of runs) never creates a duplicate cluster and
	 * never changes its pseudonym — with ONE exception: when a newly learned
	 * REAL alias equals an existing pseudonym (of any cluster), that cluster is
	 * re-minted (the old pseudonym would otherwise be a real person's name — a
	 * fail-open) and the old value is kept in `supersededPseudonyms` so
	 * write-back can repair earlier artifacts.
	 *
	 * @throws PseudonymMapIntegrityError when a platform identity is claimed by
	 *   a second cluster. One identity = one person; merging identities is the
	 *   merge engine's job, and silently re-homing a handle here would either
	 *   link two people or split one — both corruption.
	 */
	assign(input: AssignClusterInput): PseudonymClusterRecord {
		if (typeof input.clusterId !== "string" || input.clusterId.length === 0) {
			throw new PseudonymMapIntegrityError(
				"clusterId must be a non-empty string",
			);
		}
		if (
			typeof input.rulesetVersion !== "string" ||
			input.rulesetVersion.length === 0
		) {
			throw new PseudonymMapIntegrityError(
				`cluster ${JSON.stringify(input.clusterId)} assigned without a rulesetVersion`,
			);
		}

		const aliases = this.acceptableAliases(input.aliases);
		const identities = dedupeIdentities(input.identities ?? []);

		// Identity uniqueness gate BEFORE any mutation, so a rejected assign
		// leaves the map untouched.
		for (const identity of identities) {
			const key = identityKey(identity);
			const owner = this.identityOwner.get(key);
			if (owner !== undefined && owner !== input.clusterId) {
				throw new PseudonymMapIntegrityError(
					`identity ${identity.platform}:${identity.handle} already belongs to cluster ${JSON.stringify(
						owner,
					)}; refusing to re-home it to ${JSON.stringify(
						input.clusterId,
					)} (identity merges go through the merge engine)`,
				);
			}
		}

		let state = this.clusters.get(input.clusterId);
		if (!state) {
			state = {
				clusterId: input.clusterId,
				kind: input.kind,
				pseudonym: "",
				aliases: [],
				identities: [],
				evidence: [],
				firstSeen: this.now(),
				rulesetVersion: input.rulesetVersion,
				supersededPseudonyms: [],
			};
			this.clusters.set(input.clusterId, state);
			state.pseudonym = this.mintUniquePseudonym(state);
			this.pseudonymsLower.set(state.pseudonym.toLowerCase(), state.clusterId);
		}

		// Union new facts (idempotent, case-insensitive dedupe on aliases).
		const knownAliasesLower = new Set(
			state.aliases.map((a) => a.toLowerCase()),
		);
		for (const alias of aliases) {
			const lower = alias.toLowerCase();
			if (!knownAliasesLower.has(lower)) {
				state.aliases.push(alias);
				knownAliasesLower.add(lower);
			}
			let owners = this.aliasOwners.get(lower);
			if (!owners) {
				owners = new Set();
				this.aliasOwners.set(lower, owners);
			}
			owners.add(state.clusterId);
			// A real alias that equals an existing pseudonym (any cluster's) makes
			// that pseudonym unusable: re-mint it, keep the old one for repair.
			const collidingClusterId = this.pseudonymsLower.get(lower);
			if (collidingClusterId !== undefined) {
				const colliding = this.clusters.get(collidingClusterId);
				if (colliding) this.remint(colliding);
			}
		}

		const knownIdentityKeys = new Set(state.identities.map(identityKey));
		for (const identity of identities) {
			const key = identityKey(identity);
			if (!knownIdentityKeys.has(key)) {
				state.identities.push(identity);
				knownIdentityKeys.add(key);
			}
			this.identityOwner.set(key, state.clusterId);
		}

		const knownEvidence = new Set(state.evidence);
		for (const item of input.evidence ?? []) {
			const trimmed = item.trim();
			if (trimmed.length > 0 && !knownEvidence.has(trimmed)) {
				state.evidence.push(trimmed);
				knownEvidence.add(trimmed);
			}
		}

		state.rulesetVersion = input.rulesetVersion;
		return toRecord(state);
	}

	/** The cluster record, or `undefined`. */
	getCluster(clusterId: string): PseudonymClusterRecord | undefined {
		const state = this.clusters.get(clusterId);
		return state ? toRecord(state) : undefined;
	}

	/**
	 * Every cluster claiming `alias` (case-insensitive). Length 0 = unknown,
	 * 1 = resolvable, 2+ = ambiguous (escalate with context, never guess).
	 */
	clustersForAlias(alias: string): PseudonymClusterRecord[] {
		const owners = this.aliasOwners.get(alias.trim().toLowerCase());
		if (!owners) return [];
		const records: PseudonymClusterRecord[] = [];
		for (const clusterId of owners) {
			const state = this.clusters.get(clusterId);
			if (state) records.push(toRecord(state));
		}
		return records;
	}

	/** The cluster owning a platform identity, or `undefined`. */
	clusterForIdentity(
		platform: string,
		handle: string,
	): PseudonymClusterRecord | undefined {
		const owner = this.identityOwner.get(identityKey({ platform, handle }));
		return owner ? this.getCluster(owner) : undefined;
	}

	/**
	 * The model-facing assignment slice for one cluster:
	 * `{entityClusterId, surrogate, kind}` — never a real alias.
	 */
	assignmentFor(clusterId: string): PiiPseudonymAssignment | undefined {
		const state = this.clusters.get(clusterId);
		if (!state) return undefined;
		return {
			entityClusterId: state.clusterId,
			surrogate: state.pseudonym,
			kind: state.kind,
		};
	}

	/**
	 * The per-chunk assignment slice: assignments for every cluster with at
	 * least one alias occurring in `text` (boundary-aware, longest-first,
	 * case-sensitive — aliases are learned in their observed forms). Ambiguous
	 * aliases contribute ALL owning clusters, so the model sees every candidate
	 * identity and decides with context. NEVER returns the whole map.
	 */
	assignmentsForText(text: string): PiiPseudonymAssignment[] {
		if (!text || this.clusters.size === 0) return [];
		const matcher = this.compileAliasMatcher();
		if (!matcher) return [];
		matcher.regex.lastIndex = 0;
		const hit = new Set<string>();
		for (const match of text.matchAll(matcher.regex)) {
			const owners = this.aliasOwners.get(match[0].toLowerCase());
			if (!owners) continue;
			for (const clusterId of owners) hit.add(clusterId);
		}
		const assignments: PiiPseudonymAssignment[] = [];
		for (const clusterId of hit) {
			const assignment = this.assignmentFor(clusterId);
			if (assignment) assignments.push(assignment);
		}
		return assignments;
	}

	/**
	 * Deterministically replace every UNAMBIGUOUS alias in `text` with its
	 * cluster's pseudonym (single boundary-aware longest-first pass, the exact
	 * semantics of the session pseudonymizer). Aliases owned by 2+ clusters are
	 * left untouched and reported in `ambiguous` — they are model-judgment
	 * candidates, not deterministic rewrites.
	 */
	substituteAliases(text: string): AliasSubstitutionResult {
		if (!text || this.clusters.size === 0) {
			return { text, applied: [], ambiguous: [] };
		}

		const ambiguous = new Set<string>();
		const appliedClusters = new Set<string>();
		const pairs: { from: string; to: string }[] = [];
		for (const state of this.clusters.values()) {
			for (const alias of state.aliases) {
				const owners = this.aliasOwners.get(alias.toLowerCase());
				if (owners && owners.size > 1) {
					// Ambiguous alias: mapped to ITSELF. Being in the (longest-first)
					// alternation shields it from partial rewrites by a shorter
					// contained alias ("John" must not fire inside the ambiguous
					// "John Smith") while leaving the ambiguous span untouched for
					// model escalation.
					pairs.push({ from: alias, to: alias });
					continue;
				}
				pairs.push({ from: alias, to: state.pseudonym });
			}
			// Idempotency: a pseudonym already present in the text (an earlier
			// scrub pass) maps to itself, so re-substitution never double-swaps.
			pairs.push({ from: state.pseudonym, to: state.pseudonym });
		}

		let result = text;
		const replacer = compileReplacer(pairs);
		if (replacer) {
			replacer.regex.lastIndex = 0;
			result = text.replace(replacer.regex, (match) => {
				const to = replacer.map.get(match);
				if (to === undefined) return match;
				if (to !== match) {
					const owners = this.aliasOwners.get(match.toLowerCase());
					if (owners) {
						for (const clusterId of owners) appliedClusters.add(clusterId);
					}
				}
				return to;
			});
		}

		// Ambiguous aliases still present in the ORIGINAL text are surfaced so
		// the caller escalates them as candidate spans.
		const ambiguousAliases = [...this.aliasOwners.entries()]
			.filter(([, owners]) => owners.size > 1)
			.map(([lower]) => lower);
		if (ambiguousAliases.length > 0) {
			for (const state of this.clusters.values()) {
				for (const alias of state.aliases) {
					const owners = this.aliasOwners.get(alias.toLowerCase());
					if (!owners || owners.size <= 1) continue;
					const probe = compileReplacer([{ from: alias, to: alias }]);
					if (probe) {
						probe.regex.lastIndex = 0;
						if (probe.regex.test(text)) ambiguous.add(alias);
					}
				}
			}
		}

		const applied: PiiPseudonymAssignment[] = [];
		for (const clusterId of appliedClusters) {
			const assignment = this.assignmentFor(clusterId);
			if (assignment) applied.push(assignment);
		}
		return { text: result, applied, ambiguous: [...ambiguous] };
	}

	/** Serialize the whole map — the SECRET artifact. Persist ONLY via a
	 * {@link ./pii-pseudonym-map-store | protected store}. */
	toSnapshot(): PseudonymMapSnapshot {
		return {
			version: 1,
			salt: this.salt,
			clusters: this.records,
		};
	}

	/**
	 * Rebuild a map from a snapshot. Structural validation is fail-closed: a
	 * malformed snapshot throws rather than yielding a partial map (a partial
	 * map would mint NEW pseudonyms for already-mapped people — a corpus-wide
	 * consistency break, worse than stopping the pipeline).
	 */
	static fromSnapshot(
		snapshot: PseudonymMapSnapshot,
		options: Omit<CorpusPseudonymMapOptions, "salt"> = {},
	): CorpusPseudonymMap {
		assertValidSnapshot(snapshot);
		const map = new CorpusPseudonymMap({ ...options, salt: snapshot.salt });
		for (const record of snapshot.clusters) {
			const state: ClusterState = {
				clusterId: record.clusterId,
				kind: record.kind,
				pseudonym: record.pseudonym,
				aliases: [...record.aliases],
				identities: record.identities.map((i) => ({ ...i })),
				evidence: [...record.evidence],
				firstSeen: record.firstSeen,
				rulesetVersion: record.rulesetVersion,
				supersededPseudonyms: [...record.supersededPseudonyms],
			};
			map.clusters.set(state.clusterId, state);
			map.pseudonymsLower.set(state.pseudonym.toLowerCase(), state.clusterId);
			for (const alias of state.aliases) {
				const lower = alias.toLowerCase();
				let owners = map.aliasOwners.get(lower);
				if (!owners) {
					owners = new Set();
					map.aliasOwners.set(lower, owners);
				}
				owners.add(state.clusterId);
			}
			for (const identity of state.identities) {
				map.identityOwner.set(identityKey(identity), state.clusterId);
			}
		}
		return map;
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	/** Filter raw alias inputs down to swappable surface forms. */
	private acceptableAliases(aliases: readonly string[]): string[] {
		const accepted: string[] = [];
		for (const raw of aliases) {
			if (typeof raw !== "string") continue;
			const alias = raw.trim();
			if (alias.length < this.minAliasLength) continue;
			if (this.blocklistLower.has(alias.toLowerCase())) continue;
			accepted.push(alias);
		}
		return accepted;
	}

	/**
	 * Mint a pseudonym unique across the corpus: never (case-insensitively)
	 * equal to any existing pseudonym, any known real alias of ANY cluster, or
	 * a blocklisted value. Deterministic probe on collision, seeded by
	 * `(salt, kind, clusterId, attempt)` — cluster-keyed, so the same cluster
	 * re-mints identically under the same salt regardless of surface strings.
	 */
	private mintUniquePseudonym(state: ClusterState): string {
		for (let attempt = 0; attempt < 512; attempt += 1) {
			const candidate = mintSurrogate(
				this.salt,
				state.kind,
				state.clusterId,
				attempt,
			);
			const lower = candidate.toLowerCase();
			if (this.pseudonymsLower.has(lower)) continue;
			if (this.aliasOwners.has(lower)) continue;
			if (this.blocklistLower.has(lower)) continue;
			return candidate;
		}
		// Astronomically unlikely: salt-derived unique suffix keeps the mapping
		// bijective rather than risking an ambiguous corpus.
		const fallback = `${mintSurrogate(this.salt, state.kind, state.clusterId, 0)} ${this.clusters.size.toString(36)}x`;
		return fallback;
	}

	/** Replace a cluster's pseudonym after a real-alias collision. */
	private remint(state: ClusterState): void {
		const old = state.pseudonym;
		this.pseudonymsLower.delete(old.toLowerCase());
		const fresh = this.mintUniquePseudonym(state);
		state.pseudonym = fresh;
		this.pseudonymsLower.set(fresh.toLowerCase(), state.clusterId);
		if (!state.supersededPseudonyms.includes(old)) {
			state.supersededPseudonyms.push(old);
		}
	}

	/** Single alternation over every observed alias form, for one-pass matching. */
	private compileAliasMatcher(): { regex: RegExp } | null {
		const pairs: { from: string; to: string }[] = [];
		for (const state of this.clusters.values()) {
			for (const alias of state.aliases) {
				pairs.push({ from: alias, to: alias });
			}
		}
		const compiled = compileReplacer(pairs);
		return compiled ? { regex: compiled.regex } : null;
	}
}

function toRecord(state: ClusterState): PseudonymClusterRecord {
	return {
		clusterId: state.clusterId,
		kind: state.kind,
		pseudonym: state.pseudonym,
		aliases: [...state.aliases],
		identities: state.identities.map((i) => ({ ...i })),
		evidence: [...state.evidence],
		firstSeen: state.firstSeen,
		rulesetVersion: state.rulesetVersion,
		supersededPseudonyms: [...state.supersededPseudonyms],
	};
}

function dedupeIdentities(
	identities: readonly PseudonymClusterIdentity[],
): PseudonymClusterIdentity[] {
	const seen = new Set<string>();
	const out: PseudonymClusterIdentity[] = [];
	for (const identity of identities) {
		if (
			typeof identity?.platform !== "string" ||
			typeof identity?.handle !== "string"
		) {
			continue;
		}
		const platform = identity.platform.trim();
		const handle = identity.handle.trim();
		if (platform.length === 0 || handle.length === 0) continue;
		const key = identityKey({ platform, handle });
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ platform, handle });
	}
	return out;
}

/**
 * Structural fail-closed validation of a snapshot (see
 * {@link CorpusPseudonymMap.fromSnapshot}).
 */
export function assertValidSnapshot(
	snapshot: unknown,
): asserts snapshot is PseudonymMapSnapshot {
	if (snapshot === null || typeof snapshot !== "object") {
		throw new PseudonymMapIntegrityError("snapshot is not an object");
	}
	const s = snapshot as Partial<PseudonymMapSnapshot>;
	if (s.version !== 1) {
		throw new PseudonymMapIntegrityError(
			`unsupported snapshot version ${JSON.stringify(s.version)}`,
		);
	}
	if (typeof s.salt !== "string" || s.salt.length === 0) {
		throw new PseudonymMapIntegrityError("snapshot is missing its mint salt");
	}
	if (!Array.isArray(s.clusters)) {
		throw new PseudonymMapIntegrityError("snapshot clusters is not an array");
	}
	const clusterIds = new Set<string>();
	const pseudonymsLower = new Set<string>();
	const identityKeys = new Set<string>();
	for (const cluster of s.clusters as readonly Partial<PseudonymClusterRecord>[]) {
		if (cluster === null || typeof cluster !== "object") {
			throw new PseudonymMapIntegrityError("cluster is not an object");
		}
		if (
			typeof cluster.clusterId !== "string" ||
			cluster.clusterId.length === 0
		) {
			throw new PseudonymMapIntegrityError("cluster has no clusterId");
		}
		if (clusterIds.has(cluster.clusterId)) {
			throw new PseudonymMapIntegrityError(
				`duplicate cluster ${JSON.stringify(cluster.clusterId)}`,
			);
		}
		clusterIds.add(cluster.clusterId);
		if (typeof cluster.kind !== "string" || cluster.kind.length === 0) {
			throw new PseudonymMapIntegrityError(
				`cluster ${JSON.stringify(cluster.clusterId)} has no kind`,
			);
		}
		if (
			typeof cluster.pseudonym !== "string" ||
			cluster.pseudonym.length === 0
		) {
			throw new PseudonymMapIntegrityError(
				`cluster ${JSON.stringify(cluster.clusterId)} has no pseudonym`,
			);
		}
		const pseudonymLower = cluster.pseudonym.toLowerCase();
		if (pseudonymsLower.has(pseudonymLower)) {
			throw new PseudonymMapIntegrityError(
				`pseudonym ${JSON.stringify(cluster.pseudonym)} is shared by two clusters (mapping is no longer bijective)`,
			);
		}
		pseudonymsLower.add(pseudonymLower);
		if (
			!Array.isArray(cluster.aliases) ||
			cluster.aliases.some((a) => typeof a !== "string")
		) {
			throw new PseudonymMapIntegrityError(
				`cluster ${JSON.stringify(cluster.clusterId)} has malformed aliases`,
			);
		}
		if (
			!Array.isArray(cluster.identities) ||
			cluster.identities.some(
				(i) =>
					i === null ||
					typeof i !== "object" ||
					typeof (i as PseudonymClusterIdentity).platform !== "string" ||
					typeof (i as PseudonymClusterIdentity).handle !== "string",
			)
		) {
			throw new PseudonymMapIntegrityError(
				`cluster ${JSON.stringify(cluster.clusterId)} has malformed identities`,
			);
		}
		for (const identity of cluster.identities as readonly PseudonymClusterIdentity[]) {
			const key = identityKey(identity);
			if (identityKeys.has(key)) {
				throw new PseudonymMapIntegrityError(
					`identity ${identity.platform}:${identity.handle} appears in two clusters (one identity = one person)`,
				);
			}
			identityKeys.add(key);
		}
		if (
			!Array.isArray(cluster.evidence) ||
			cluster.evidence.some((e) => typeof e !== "string")
		) {
			throw new PseudonymMapIntegrityError(
				`cluster ${JSON.stringify(cluster.clusterId)} has malformed evidence`,
			);
		}
		if (typeof cluster.firstSeen !== "number") {
			throw new PseudonymMapIntegrityError(
				`cluster ${JSON.stringify(cluster.clusterId)} has no firstSeen`,
			);
		}
		if (
			typeof cluster.rulesetVersion !== "string" ||
			cluster.rulesetVersion.length === 0
		) {
			throw new PseudonymMapIntegrityError(
				`cluster ${JSON.stringify(cluster.clusterId)} has no rulesetVersion`,
			);
		}
		if (
			!Array.isArray(cluster.supersededPseudonyms) ||
			cluster.supersededPseudonyms.some((p) => typeof p !== "string")
		) {
			throw new PseudonymMapIntegrityError(
				`cluster ${JSON.stringify(cluster.clusterId)} has malformed supersededPseudonyms`,
			);
		}
	}
}
