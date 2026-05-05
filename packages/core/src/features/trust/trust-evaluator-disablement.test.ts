import { describe, expect, it } from "vitest";
import { createBasicCapabilitiesPlugin } from "../basic-capabilities/index.ts";
import { trustCapability } from "../index.ts";
import trustPlugin, {
	createTrustPlugin,
	securityEvaluator,
	trustChangeEvaluator,
	trustEvaluators,
} from "./index.ts";

const DISABLED_TRUST_EVALUATORS = [
	"securityEvaluator",
	"trustChangeEvaluator",
] as const;

function evaluatorNames(
	evaluators: Array<{ name: string }> | undefined,
): string[] {
	return (evaluators ?? []).map((evaluator) => evaluator.name);
}

function expectDisabledEvaluatorsExcluded(
	evaluators: Array<{ name: string }> | undefined,
) {
	const names = evaluatorNames(evaluators);
	for (const evaluatorName of DISABLED_TRUST_EVALUATORS) {
		expect(names).not.toContain(evaluatorName);
	}
}

function expectTrustEvaluatorsNotAlwaysRun(
	evaluators: Array<{ name: string; alwaysRun?: boolean }> | undefined,
) {
	for (const evaluator of evaluators ?? []) {
		if (
			DISABLED_TRUST_EVALUATORS.includes(
				evaluator.name as (typeof DISABLED_TRUST_EVALUATORS)[number],
			)
		) {
			expect(evaluator.alwaysRun).not.toBe(true);
		}
	}
}

describe("trust evaluator disablement", () => {
	it("excludes trust and security evaluators from the default trust plugin", () => {
		expectDisabledEvaluatorsExcluded(trustPlugin.evaluators);
		expectTrustEvaluatorsNotAlwaysRun(trustPlugin.evaluators);
	});

	it("excludes trust and security evaluators from the core trust capability", () => {
		expectDisabledEvaluatorsExcluded(trustCapability.evaluators);
		expectTrustEvaluatorsNotAlwaysRun(trustCapability.evaluators);
	});

	it("keeps the default basic capability evaluator list free of trust evaluators", () => {
		expectDisabledEvaluatorsExcluded(
			createBasicCapabilitiesPlugin().evaluators,
		);
		expectDisabledEvaluatorsExcluded(
			createBasicCapabilitiesPlugin({ enableTrust: true }).evaluators,
		);
	});

	it("keeps explicit opt-in trust evaluators from always running", () => {
		const optInTrustPlugin = createTrustPlugin({ enableEvaluators: true });

		expect(evaluatorNames(optInTrustPlugin.evaluators).sort()).toEqual(
			[...DISABLED_TRUST_EVALUATORS].sort(),
		);
		expect(securityEvaluator.alwaysRun).not.toBe(true);
		expect(trustChangeEvaluator.alwaysRun).not.toBe(true);
		expectTrustEvaluatorsNotAlwaysRun(trustEvaluators);
		expectTrustEvaluatorsNotAlwaysRun(optInTrustPlugin.evaluators);
	});
});
