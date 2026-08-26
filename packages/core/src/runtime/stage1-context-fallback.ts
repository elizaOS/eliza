/**
 * Deterministic resolution of Stage 1's selected context ids against the
 * turn's available-context list. Stage 1 occasionally routes to a context id
 * the current room/role surface does not offer (live 2026-08-24, room
 * 46a7751d, tj-d2f8ceab0da3e3..tj-d469e848822904: contexts=["tasks"] +
 * requiresTool=true where only simple/general were available). Silently
 * dropping the unknown id empties the plan's contexts and strands the turn on
 * the bare Stage-1 ack — a commitment-shaped promise no machinery honors.
 * This resolver keeps the known ids, records the dropped ones, and — when the
 * plan committed to tool work — substitutes the `general` fallback context so
 * the planner pipeline still runs with the Stage-1 candidates and either
 * honors the ack or replaces it with an honest reply.
 */
import type { AgentContext } from "../types/contexts";
import { SIMPLE_CONTEXT_ID } from "./message-handler";

/** Context id substituted for an all-unknown planning selection. */
export const STAGE1_FALLBACK_CONTEXT_ID: AgentContext = "general";

export interface Stage1ContextFallbackArgs {
	/** Stage 1's selected context ids, as parsed (may hold unknown ids). */
	selectedContexts: readonly AgentContext[];
	/**
	 * Ids of the contexts actually available on this turn's surface. An empty
	 * list means "availability unknown" and the resolver passes the selection
	 * through unchanged (mirrors the permissive contract of the role filter).
	 */
	availableContextIds: readonly string[];
	/** Stage 1's requiresTool vote, verbatim (undefined = unstated). */
	requiresTool?: boolean;
	/** Number of candidate actions Stage 1 (or a backstop) named. */
	candidateActionCount: number;
}

export interface Stage1ContextFallbackResolution {
	/** The resolved context list to plan/route with. */
	contexts: AgentContext[];
	/** Selected ids that are not on the available surface (deduped). */
	droppedUnknownContexts: AgentContext[];
	/** True when `general` was substituted for an all-unknown planning pick. */
	fallbackApplied: boolean;
	/** True when the resolved list differs from the selection. */
	changed: boolean;
}

function normalizeId(value: unknown): string {
	return String(value ?? "")
		.trim()
		.toLowerCase();
}

/**
 * Resolve Stage 1's context selection against the available surface.
 *
 * - Known ids are kept in selection order (deduped, normalized lowercase).
 * - `simple` is the routing marker, not a registered definition — it is
 *   always treated as known.
 * - Unknown ids are dropped and reported.
 * - When every non-simple selection was unknown AND the plan committed to
 *   tool work (requiresTool=true, or named candidates without an explicit
 *   requiresTool=false), `general` is appended so the router still enters
 *   planning with the Stage-1 candidates instead of dead-ending the turn on
 *   the ack.
 */
export function resolveStage1ContextFallback(
	args: Stage1ContextFallbackArgs,
): Stage1ContextFallbackResolution {
	const selection = args.selectedContexts
		.map((context) => normalizeId(context))
		.filter((context) => context.length > 0);

	const unchanged: Stage1ContextFallbackResolution = {
		contexts: selection as AgentContext[],
		droppedUnknownContexts: [],
		fallbackApplied: false,
		changed: false,
	};
	if (selection.length === 0 || args.availableContextIds.length === 0) {
		return unchanged;
	}

	const available = new Set(
		args.availableContextIds
			.map((id) => normalizeId(id))
			.filter((id) => id.length > 0),
	);

	const known: AgentContext[] = [];
	const dropped: AgentContext[] = [];
	const seenKnown = new Set<string>();
	const seenDropped = new Set<string>();
	for (const context of selection) {
		if (context === SIMPLE_CONTEXT_ID || available.has(context)) {
			if (!seenKnown.has(context)) {
				seenKnown.add(context);
				known.push(context as AgentContext);
			}
			continue;
		}
		if (!seenDropped.has(context)) {
			seenDropped.add(context);
			dropped.push(context as AgentContext);
		}
	}
	if (dropped.length === 0) {
		return unchanged;
	}

	const toolCommitted =
		args.requiresTool === true ||
		(args.candidateActionCount > 0 && args.requiresTool !== false);
	const hasKnownNonSimple = known.some(
		(context) => context !== SIMPLE_CONTEXT_ID,
	);
	const contexts = [...known];
	let fallbackApplied = false;
	if (toolCommitted && !hasKnownNonSimple) {
		if (!seenKnown.has(STAGE1_FALLBACK_CONTEXT_ID)) {
			contexts.push(STAGE1_FALLBACK_CONTEXT_ID);
		}
		fallbackApplied = true;
	}

	return {
		contexts,
		droppedUnknownContexts: dropped,
		fallbackApplied,
		changed: true,
	};
}
