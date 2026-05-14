/**
 * Token-tree (prefix-trie) for deterministic-region decode.
 *
 * Background
 * ----------
 * The local llama-server engine constrains structured output (Stage-1
 * HANDLE_RESPONSE envelope, Stage-2 PLAN_ACTIONS args) with a GBNF grammar
 * produced by `@elizaos/core` `buildResponseGrammar` /
 * `buildPlannerActionGrammarStrict`. Grammar enforcement is a *rejection*
 * filter — the model samples a token, the sampler rejects invalid ones, and
 * if the top-K sample is rejected the engine re-rolls. That's wasted forward
 * passes inside positions where the *set of legal continuations is already
 * pinned by the grammar* (an enum value, an action name from the exposed
 * tools, a numeric field with a known range).
 *
 * This module produces the data the fork-side sampler needs to skip the
 * re-roll entirely: a tokenized prefix-trie of the exposed action names (or
 * the values of an enum field). At each generation step inside the
 * constrained span the sampler walks one step in the trie, restricts the
 * logit pool to ONLY the valid next tokens, and takes argmax. Never produces
 * an invalid token, never re-rolls.
 *
 * Relationship to existing pieces
 * --------------------------------
 *   - `@elizaos/core` `buildPlannerActionGrammarStrict(...)` — already emits
 *     the GBNF that pins the `action` value to a fixed enum and constrains
 *     each branch's `parameters`. The trie here is the per-token
 *     materialisation of that same enum, ready for the fork's
 *     argmax-among-valid-tokens path (P2-6 in
 *     `packages/training/benchmarks/INFERENCE_OPTIMIZATION_PLAN.md`).
 *   - `ResponseSkeleton.spans` (in `packages/core/src/types/model.ts`) —
 *     each `enum` span's `enumValues` is the input set this module
 *     tokenizes. Single-value enums are already collapsed to `literal` spans
 *     by the producer, so the trie only matters for multi-value enums.
 *
 * What this module is NOT
 * -----------------------
 *   - It does NOT itself constrain decode — that requires the fork-side
 *     sampler to consume the trie. The wire format here is an offline
 *     description; server-side wiring is tracked under P2-6.
 *   - It does NOT replace the GBNF grammar. The grammar still defines the
 *     JSON envelope and the cross-span structure; the trie applies inside
 *     individual `enum` spans (or the action-name value of the planner
 *     envelope).
 */

/**
 * A single node in a token-prefix trie.
 *
 * Invariants:
 *   - `tokenId` is the token id of the edge that *enters* this node. The
 *     synthetic root has no entering token; we model that with `tokenId =
 *     -1` and treat it as a sentinel.
 *   - `children` is keyed by the next-token id; lookups are O(1).
 *   - `isTerminal` is true when the path from root to this node spells a
 *     complete leaf value. A node may be both terminal AND have children —
 *     that's the case when one leaf is a strict prefix of another (e.g.
 *     `OWN` is a prefix of `OWNER_REMINDERS` if the tokenizer splits them
 *     into prefix-sharing token sequences). The sampler stops if `isTerminal
 *     && children.size === 0`; otherwise it may continue greedily provided
 *     the next-token argmax is still in `children`.
 *   - `leafName` carries the original leaf value the path encodes — used
 *     for debugging / telemetry only. Set on every terminal node.
 */
export interface TokenTrieNode {
	tokenId: number;
	children: Map<number, TokenTrieNode>;
	isTerminal: boolean;
	leafName?: string;
}

/** Sentinel tokenId for the synthetic root node. */
export const TRIE_ROOT_TOKEN_ID = -1;

/**
 * A single tokenized leaf value: the original string `name` plus its token
 * id sequence under some tokenizer. The token sequence must be non-empty —
 * empty leaves are skipped by the builder (an empty value can't constrain
 * anything).
 */
export interface TokenSequence {
	name: string;
	tokens: number[];
}

/**
 * Build a token-prefix trie from a set of tokenized leaf values.
 *
 * Multiple inputs sharing a prefix share that prefix in the trie (one
 * `children` entry per distinct edge token). Duplicate `(name, tokens)`
 * inputs are tolerated; identical paths collapse onto one terminal node.
 * Distinct names that happen to tokenize to the same id sequence (rare but
 * possible when an action name is renamed) collapse onto one terminal node
 * whose `leafName` is the lexicographically-smallest input — the leaf-name
 * tag is informational; the constraint is the path.
 *
 * Empty `sequences` returns a root with no children (a no-op trie — every
 * step is unconstrained from the trie's perspective). The caller should
 * either skip the trie path entirely in that case or fall back to grammar.
 */
export function buildTokenTrie(
	sequences: ReadonlyArray<TokenSequence>,
): TokenTrieNode {
	const root: TokenTrieNode = {
		tokenId: TRIE_ROOT_TOKEN_ID,
		children: new Map(),
		isTerminal: false,
	};
	for (const seq of sequences) {
		if (seq.tokens.length === 0) continue;
		let node = root;
		for (const tok of seq.tokens) {
			let next = node.children.get(tok);
			if (!next) {
				next = {
					tokenId: tok,
					children: new Map(),
					isTerminal: false,
				};
				node.children.set(tok, next);
			}
			node = next;
		}
		// Multiple inputs colliding on the same path: keep the smallest name as
		// the stable identifier so two callers building the same trie from the
		// same (out-of-order) input both produce the same telemetry tag.
		if (!node.isTerminal) {
			node.isTerminal = true;
			node.leafName = seq.name;
		} else if (seq.name < (node.leafName ?? "")) {
			node.leafName = seq.name;
		}
	}
	return root;
}

/**
 * Wire format for the per-turn token-tree carried alongside the existing
 * structured-decode contract (`responseSkeleton` / `grammar`). This is what
 * the harness packs into the chat-completion request body as
 * `eliza_token_tree` (or surfaces under `providerOptions.eliza.tokenTrees`
 * — naming TBD when the fork-side hook lands).
 *
 * One descriptor per constrained span / field. For Stage-2 planner the
 * primary entry is the `action` span; multi-value enum parameter fields
 * may produce additional entries keyed by the `parameters.<field>` path.
 *
 * The trie is encoded as a sorted leaf list (`leaves`) rather than a nested
 * structure — JSON-serializable, deterministic, and the fork rebuilds the
 * `Map`-based trie in O(total_tokens) on receipt. The leaf-only form also
 * keeps the wire format compact: at most `Σ |tokens|` integers across the
 * entries, no per-node overhead.
 */
export interface TokenTreeDescriptor {
	/**
	 * Dotted path of the constrained span, relative to the response envelope
	 * root. For the planner the canonical value is `"action"`; for an enum
	 * parameter field it is `"parameters.<fieldName>"`. For the Stage-1
	 * `contexts` array's *element* enum it would be `"contexts[]"` — the
	 * empty bracket suffix indicates "applies to each element".
	 */
	path: string;
	/**
	 * The tokenized leaves the sampler may complete inside this span. Order
	 * is irrelevant for correctness (the trie is order-insensitive), but the
	 * builder normalises to `(name asc)` so the wire format is byte-stable
	 * across turns when the constrained value set is unchanged.
	 */
	leaves: TokenSequence[];
}

/**
 * Per-turn payload assembled from the exposed action set and any
 * enum-valued evaluator / parameter fields. Carried alongside `grammar` /
 * `responseSkeleton` on the chat-completion request.
 *
 * `modelId` is the tokenizer key — different Eliza-1 variants share the
 * Qwen3 tokenizer family but distinct distillations may have different
 * special-token ids, so leaves tokenized against one model are NOT portable
 * to another. The fork should validate that the active model's id matches
 * this descriptor's `modelId` before honouring the trie.
 */
export interface TokenTreePayload {
	modelId: string;
	descriptors: TokenTreeDescriptor[];
}

/**
 * Sort a descriptor's leaves to the canonical `(name asc)` order. Pure —
 * returns a new array; caller's reference is untouched.
 */
function sortLeaves(
	leaves: ReadonlyArray<TokenSequence>,
): TokenSequence[] {
	return [...leaves].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Materialise a `TokenTreeDescriptor` from a path + name→tokens map. Names
 * absent from `tokenMap` (e.g. an action that wasn't tokenized yet) are
 * silently skipped — the caller is expected to have prefetched the
 * tokenizations via `TokenizerClient.tokenizeMany`. Returns `null` when no
 * leaves survive filtering (no descriptor is emitted in that case so the
 * fork doesn't try to constrain an empty set).
 */
export function buildTokenTreeDescriptor(
	path: string,
	names: ReadonlyArray<string>,
	tokenMap: ReadonlyMap<string, number[]>,
): TokenTreeDescriptor | null {
	const seen = new Set<string>();
	const leaves: TokenSequence[] = [];
	for (const name of names) {
		if (seen.has(name)) continue;
		const tokens = tokenMap.get(name);
		if (!tokens || tokens.length === 0) continue;
		seen.add(name);
		leaves.push({ name, tokens: [...tokens] });
	}
	if (leaves.length === 0) return null;
	return { path, leaves: sortLeaves(leaves) };
}

/**
 * Walk one step in a trie. Given the current node and a candidate next
 * token, return the child node if the token is a valid continuation; null
 * otherwise. The sampler's "argmax restricted to valid tokens" reduces to:
 *   1. Build the candidate set from `node.children.keys()`.
 *   2. Pick the candidate with the highest logit.
 *   3. `node = step(node, picked)` — non-null by construction.
 */
export function step(
	node: TokenTrieNode,
	tokenId: number,
): TokenTrieNode | null {
	return node.children.get(tokenId) ?? null;
}

/**
 * True when the trie has no further branching from `node`: the current path
 * is the only legal completion. Useful for telling the sampler "you can
 * stop applying the constraint after the next token; the grammar takes
 * over again." (E.g. when the JSON value's closing `"` is the only legal
 * next byte.)
 */
export function isUniqueContinuation(node: TokenTrieNode): boolean {
	return node.children.size === 0 && node.isTerminal;
}

/**
 * Estimate the trie's memory footprint in bytes for a given leaf set.
 * Back-of-envelope helper for the caching layer's eviction policy.
 * Conservative: counts ~80 bytes per node (V8 hidden-class + Map entry
 * overhead) + 16 bytes per Map slot. For 200 actions with mean 4 tokens
 * each and ~30% prefix sharing this gives ~80 KB — well under a single
 * page, fine to materialise eagerly.
 */
export function estimateTrieBytes(node: TokenTrieNode): number {
	let bytes = 0;
	const visit = (n: TokenTrieNode): void => {
		bytes += 80;
		for (const child of n.children.values()) {
			bytes += 16;
			visit(child);
		}
	};
	visit(node);
	return bytes;
}

/**
 * Count the distinct terminal nodes reachable from `node`. Test helper /
 * sanity check: must equal the count of unique tokenized leaves passed to
 * `buildTokenTrie`.
 */
export function countTerminals(node: TokenTrieNode): number {
	let n = 0;
	const visit = (cur: TokenTrieNode): void => {
		if (cur.isTerminal) n += 1;
		for (const child of cur.children.values()) visit(child);
	};
	visit(node);
	return n;
}
