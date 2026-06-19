/**
 * GateRegistry — registry of named "gates": predicates that must be true
 * before a scheduled task or pipeline step proceeds. Gates are how features
 * compose preconditions ("only if owner is awake", "only if not in a meeting",
 * "only if global pause is off") without hand-wiring every check.
 *
 * STUB — see this directory's README for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/gate.ts ->
 *               packages/core/src/registries/gate.ts)
 */

export type GateResult =
	| { readonly open: true }
	| { readonly open: false; readonly reason: string };

export type GateEvaluator = (ctx: unknown) => Promise<GateResult> | GateResult;

export interface GateDefinition {
	readonly id: string;
	readonly description?: string;
	readonly evaluate: GateEvaluator;
}

export interface GateRegistry {
	register(gate: GateDefinition): void;
	get(id: string): GateDefinition | undefined;
	list(): readonly GateDefinition[];
	evaluate(id: string, ctx: unknown): Promise<GateResult>;
}

export class StubGateRegistry implements GateRegistry {
	register(_gate: GateDefinition): void {
		throw new Error(
			"[StubGateRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	get(_id: string): GateDefinition | undefined {
		throw new Error(
			"[StubGateRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	list(): readonly GateDefinition[] {
		throw new Error(
			"[StubGateRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	async evaluate(_id: string, _ctx: unknown): Promise<GateResult> {
		throw new Error(
			"[StubGateRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}
}
