/**
 * Planner (`PLAN_ACTIONS`) skeleton + GBNF wiring for the local-inference
 * stage.
 *
 * The response-handler stage is already constrained — `shouldRespond` is a
 * three-value enum that the lazy GBNF pins (see
 * `packages/core/src/runtime/builtin-field-evaluators.ts`). The planner
 * stage, however, has historically emitted `PLAN_ACTIONS({...})` calls
 * unconstrained for local backends: the model could hallucinate action
 * names, drop required parameters, or invent free-form parameter values
 * outside the registered enum.
 *
 * This module is the local-inference-side surface for the same guided-decode
 * contract the response handler uses:
 *
 *   1. `buildPlanActionsSkeleton(actions)` — top-level envelope skeleton
 *      `{"action": <enum>, "parameters": <free-json>, "thought": <free-string>}`
 *      matching the bare-JSON form `plan-actions-extractor.ts` parses.
 *      `action` is pinned to the alternation of registered action names;
 *      collapses to a literal when only one action is exposed.
 *
 *   2. `buildPlannerGuidedDecode(actions)` — the full bundle: the skeleton
 *      above, the precise GBNF (`@elizaos/core`'s `buildPlannerActionGrammar`
 *      emits one that also pins the array-element enum), and per-action
 *      `parameters` schemas + sub-skeletons for the engine's optional second
 *      pass once `action` is committed.
 *
 * Why this lives in app-core (not core): the helper is meaningful only to
 * the local-inference layer — cloud adapters ignore `responseSkeleton` /
 * `grammar` per the existing W3 contract. Keeping the wrapper here makes
 * the local-only nature explicit at the import site and pins the test
 * surface (`__tests__/planner-grammar.test.ts`) next to the engine that
 * consumes the output.
 *
 * GBNF compiler limitation: `compileSkeletonToGbnf` cannot express
 * per-action parameter discrimination in a single flat skeleton (the spans
 * are positional; there's no anyOf-with-discriminator branch). We therefore
 * fall back to the documented two-pass shape — top-level skeleton pins
 * `action`, the engine drives a second constrained pass against the chosen
 * action's normalized JSON schema. `buildPlannerParamsSkeleton` (re-exported
 * from `@elizaos/core`) provides the per-action sub-skeleton.
 */

import {
	type Action,
	buildPlannerActionGrammar,
	buildPlannerParamsSkeleton,
	type JSONSchema,
	normalizeActionJsonSchema,
	type ResponseSkeleton,
} from "@elizaos/core";

import {
	type ElizaHarnessSchema,
	elizaHarnessSchemaFromSkeleton,
} from "./structured-output";

/**
 * The minimal shape this module consumes from an `Action`. Accepting the
 * structural pick keeps the helper testable in isolation (no handlers /
 * validators need stubbing).
 */
export type PlannerAction = Pick<
	Action,
	"name" | "parameters" | "allowAdditionalParameters"
>;

/**
 * Bundle of the structure-forcing artefacts the local-inference engine needs
 * to constrain a `PLAN_ACTIONS` generation.
 */
export interface PlannerGuidedDecode {
	/**
	 * Top-level skeleton: `{"action": <enum>, "parameters": <free-json>,
	 * "thought": <free-string>}`. Compiles to a lazy GBNF via
	 * `compileSkeletonToGbnf` — `action` is the alternation of registered
	 * action names (or a literal when only one action is exposed).
	 */
	responseSkeleton: ResponseSkeleton;
	/**
	 * Pre-built GBNF for the top-level envelope. Wins over compiling the
	 * skeleton (the explicit grammar carries the same alternation as the
	 * skeleton's enum span — they are byte-equivalent — but the explicit
	 * grammar is what the cloud-mirroring code path in
	 * `@elizaos/core`'s `buildPlannerActionGrammar` already produces).
	 */
	grammar: string;
	/**
	 * Map of action name → normalized JSON Schema for its `parameters` object.
	 * The engine uses this for the optional second constrained pass once
	 * `action` is committed. Cloud adapters ignore it; tools carry the
	 * equivalent (unforced) contract for them.
	 */
	actionSchemas: Record<string, JSONSchema>;
	/**
	 * Per-action `parameters` skeleton (single-value enums collapse to
	 * literals; multi-value enums stay as enum spans). Keyed by action name.
	 * Engines may compile each entry on demand for the second pass.
	 */
	paramsSkeletons: Record<string, ResponseSkeleton>;
	/**
	 * Eliza harness schema for the top-level envelope — the bundle of
	 * skeleton + grammar + derived prefill plan. Pass this on
	 * {@link StructuredGenerateParams.elizaSchema} to engage the
	 * deterministic-token prefill-plan fast-forward on top of the GBNF
	 * constrained decode.
	 */
	elizaSchema: ElizaHarnessSchema;
}

/**
 * Build the top-level `PLAN_ACTIONS` envelope skeleton from the action set
 * exposed this turn.
 *
 * Shape:
 *   `{"action": <enum>, "parameters": <free-json>, "thought": <free-string>}`
 *
 * Matches `plan-actions-extractor.ts`'s bare-JSON expectation:
 *   `parsed.action` is read as a string; `parameters` / `params` is read as
 *   an object; `thought` is optional. The skeleton's key order
 *   (`action, parameters, thought`) matches the parser exactly.
 *
 * Returns `null` when no actions are exposed (caller should skip
 * structure-forcing — there is nothing to constrain `action` to).
 *
 * GBNF compiler limitation: `compileSkeletonToGbnf` does not support
 * anyOf-with-discriminator in a single skeleton — the per-action parameter
 * shape cannot be expressed positionally. The engine drives a second
 * constrained pass against {@link PlannerGuidedDecode.actionSchemas} /
 * {@link PlannerGuidedDecode.paramsSkeletons} once `action` is committed.
 */
export function buildPlanActionsSkeleton(
	actions: ReadonlyArray<PlannerAction>,
): ResponseSkeleton | null {
	const result = buildPlannerActionGrammar(actions);
	if (result === null) return null;
	return result.responseSkeleton;
}

/**
 * Build the full guided-decode bundle for a `PLAN_ACTIONS` generation: the
 * top-level skeleton, the precise GBNF, the per-action parameter schemas,
 * and the per-action `parameters` sub-skeletons.
 *
 * Returns `null` when no actions are exposed.
 */
export function buildPlannerGuidedDecode(
	actions: ReadonlyArray<PlannerAction>,
): PlannerGuidedDecode | null {
	const result = buildPlannerActionGrammar(actions);
	if (result === null) return null;

	const paramsSkeletons: Record<string, ResponseSkeleton> = {};
	for (const action of actions) {
		if (!action.name) continue;
		paramsSkeletons[action.name] = buildPlannerParamsSkeleton(action);
	}

	const elizaSchema = elizaHarnessSchemaFromSkeleton({
		skeleton: result.responseSkeleton,
		grammar: result.grammar,
	});

	return {
		responseSkeleton: result.responseSkeleton,
		grammar: result.grammar,
		actionSchemas: result.actionSchemas,
		paramsSkeletons,
		elizaSchema,
	};
}

/**
 * Convenience: normalize a single action's `parameters` to a core
 * {@link JSONSchema}. Re-exported here so callers staying inside the
 * local-inference module can build per-action constraints without
 * pulling `@elizaos/core/runtime/...`.
 */
export function planActionParameterSchema(action: PlannerAction): JSONSchema {
	return normalizeActionJsonSchema(action);
}
