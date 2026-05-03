import { describe, it, test } from "vitest";

type DescribeFn = typeof describe;
type ItFn = typeof it;
type TestFn = typeof test;

export function describeIf(condition: boolean): DescribeFn {
  if (condition) {
    return describe;
  }

  return ((_: string, __?: () => void) => {}) as unknown as DescribeFn;
}

export function itIf(condition: boolean): ItFn {
  if (condition) {
    return it;
  }

  return ((_: string, __?: () => void) => {}) as unknown as ItFn;
}

export function testIf(condition: boolean): TestFn {
  if (condition) {
    return test;
  }

  return ((_: string, __?: () => void) => {}) as unknown as TestFn;
}
