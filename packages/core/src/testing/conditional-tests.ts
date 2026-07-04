/**
 * Condition-gated wrappers around Vitest's describe/it/test that fall back to
 * the `.skip` variant when the predicate is false, letting suites opt out of a
 * block without scattering inline `if` guards.
 */
import { describe, it, test } from "vitest";

type DescribeFn = typeof describe;
type ItFn = typeof it;
type TestFn = typeof test;

export function describeIf(condition: boolean): DescribeFn {
	if (condition) {
		return describe;
	}

	return describe.skip as DescribeFn;
}

export function itIf(condition: boolean): ItFn {
	if (condition) {
		return it;
	}

	return it.skip as ItFn;
}

export function testIf(condition: boolean): TestFn {
	if (condition) {
		return test;
	}

	return test.skip as TestFn;
}
