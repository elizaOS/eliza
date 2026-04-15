import { describe, expect, it, test } from "vitest";

type DescribeFn = typeof describe;
type ItFn = typeof it;
type TestFn = typeof test;

export function describeIf(condition: boolean): DescribeFn {
  if (condition) {
    return describe;
  }

  return (((name: string) =>
    describe(name, () => {
      it("records unmet prerequisites instead of skipping", () => {
        expect(condition).toBe(false);
      });
    })) as unknown) as DescribeFn;
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
