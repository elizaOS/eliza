/**
 * Per-turn entity-alias capabilities for planner tool arguments. Prompts
 * redact identifier settings as `[REDACTED:<NAME>]`; when the model copies a
 * placeholder into a tool argument the executor may substitute the real value
 * — but only from an explicit capability map minted for this turn, never from
 * an ambient `runtime.getSetting(name)` lookup keyed by model-authored text
 * (issue #20091). A guessed alias that redaction did not emit this turn, or
 * an alias on a turn that is not owner-authorized, stays redacted.
 *
 * The canonical owner alias (`ELIZA_ADMIN_ENTITY_ID`) is granted only when
 * the exact placeholder appears in the composed planner state — proof that
 * redaction emitted it — and the resolved sender roles include OWNER. The
 * value comes from the canonical owner resolution path, not a raw setting
 * read keyed by the model's string.
 *
 * Resolution transforms only the executed-args copy: recorded tool calls,
 * diagnostics, and trajectories keep the placeholder, and inputs are never
 * mutated.
 */
import { resolveCanonicalOwnerIdForMessage } from "../roles";
import type { IAgentRuntime, Memory } from "../types";
import type { RoleGateRole } from "../types/contexts";
import type { State } from "../types/state";

/**
 * Explicit per-turn alias grants: redaction alias name → the identifier value
 * it may resolve to during tool execution. Absence of a name means the alias
 * stays redacted regardless of what the model emitted.
 */
export type EntityAliasCapabilityMap = Readonly<Record<string, string>>;

export const CANONICAL_OWNER_ENTITY_ALIAS = "ELIZA_ADMIN_ENTITY_ID";

const REDACTED_ENTITY_ALIAS_REF = /^\[REDACTED:([A-Z0-9_]*_ENTITY_ID)\]$/;
const UUID_SHAPE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ALIAS_SCAN_DEPTH = 8;
const MAX_ALIAS_SCAN_NODES = 2_048;

const EMPTY_ALIASES: EntityAliasCapabilityMap = Object.freeze({});

function aliasPlaceholder(name: string): string {
	return `[REDACTED:${name}]`;
}

/**
 * True when the exact full placeholder token for `name` appears anywhere in
 * the composed state's prompt text or string values — evidence that redaction
 * (not the model's imagination) emitted the alias this turn.
 */
export function statePresentsEntityAlias(
	state: State | undefined,
	name: string,
): boolean {
	if (!state) return false;
	const token = aliasPlaceholder(name);
	if (typeof state.text === "string" && state.text.includes(token)) {
		return true;
	}
	const budget = { nodes: MAX_ALIAS_SCAN_NODES };
	return (
		containsToken(state.values, token, 0, budget) ||
		containsToken(state.data, token, 0, budget)
	);
}

function containsToken(
	value: unknown,
	token: string,
	depth: number,
	budget: { nodes: number },
): boolean {
	if (budget.nodes <= 0 || depth > MAX_ALIAS_SCAN_DEPTH) return false;
	budget.nodes -= 1;
	if (typeof value === "string") return value.includes(token);
	if (Array.isArray(value)) {
		return value.some((entry) =>
			containsToken(entry, token, depth + 1, budget),
		);
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value as Record<string, unknown>).some((entry) =>
			containsToken(entry, token, depth + 1, budget),
		);
	}
	return false;
}

/**
 * Mint the per-turn alias capability map at the planner-to-executor boundary.
 * Grants the canonical owner alias only when the composed state carries the
 * exact placeholder AND the resolved sender roles include OWNER; the value is
 * derived from canonical owner resolution and must be UUID-shaped. Failures
 * or missing preconditions yield an empty map — the placeholder then stays
 * redacted and validation rejects it, which is the safe outcome.
 */
export async function buildTurnEntityAliases(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	userRoles: readonly RoleGateRole[] | undefined,
): Promise<EntityAliasCapabilityMap> {
	if (!statePresentsEntityAlias(state, CANONICAL_OWNER_ENTITY_ALIAS)) {
		return EMPTY_ALIASES;
	}
	if (!userRoles?.includes("OWNER")) {
		return EMPTY_ALIASES;
	}
	const ownerId = await resolveCanonicalOwnerIdForMessage(runtime, message);
	if (typeof ownerId !== "string" || !UUID_SHAPE.test(ownerId)) {
		return EMPTY_ALIASES;
	}
	return Object.freeze({ [CANONICAL_OWNER_ENTITY_ALIAS]: ownerId });
}

/**
 * Substitute granted alias placeholders in tool arguments. Only exact
 * full-string placeholder matches whose alias name is present in the
 * capability map resolve; embedded placeholders, ungranted names, and
 * credential-class placeholders pass through unchanged. Recurses through
 * nested plain objects and arrays with copy-on-write semantics — the input
 * structure is never mutated, and the same reference is returned when nothing
 * resolved.
 */
export function resolveEntityAliasRefs(
	aliases: EntityAliasCapabilityMap,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (Object.keys(aliases).length === 0) return args;
	const budget = { nodes: MAX_ALIAS_SCAN_NODES };
	const resolved = resolveNode(aliases, args, 0, budget);
	return resolved === args ? args : (resolved as Record<string, unknown>);
}

function resolveNode(
	aliases: EntityAliasCapabilityMap,
	value: unknown,
	depth: number,
	budget: { nodes: number },
): unknown {
	if (budget.nodes <= 0 || depth > MAX_ALIAS_SCAN_DEPTH) return value;
	budget.nodes -= 1;
	if (typeof value === "string") {
		const match = REDACTED_ENTITY_ALIAS_REF.exec(value);
		if (!match?.[1]) return value;
		const granted = aliases[match[1]];
		if (typeof granted !== "string" || !UUID_SHAPE.test(granted)) {
			return value;
		}
		return granted;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((entry) => {
			const resolved = resolveNode(aliases, entry, depth + 1, budget);
			if (resolved !== entry) changed = true;
			return resolved;
		});
		return changed ? next : value;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(record)) {
			const resolved = resolveNode(aliases, entry, depth + 1, budget);
			if (resolved !== entry) changed = true;
			// JSON.parse can hand us an own "__proto__" key; plain assignment
			// would invoke the prototype setter on the copy instead of defining
			// an own property, silently swapping the copy's prototype.
			Object.defineProperty(next, key, {
				value: resolved,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return changed ? next : value;
	}
	return value;
}
