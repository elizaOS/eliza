import { describe, it, test } from "vitest";

type SuiteCallback = () => void | Promise<void>;
type TestCallback = () => void | Promise<void>;

type DescribeGate = (
  name: string,
  fn: SuiteCallback,
) => ReturnType<typeof describe>;

type TestGate = (
  name: string,
  fn: TestCallback,
  timeout?: number,
) => ReturnType<typeof it>;

export function describeIf(condition: boolean): DescribeGate {
  if (condition) {
    return (name, fn) => describe(name, fn);
  }

  return (name) =>
    describe.skip(name, () => {
      it("skipped because prerequisites are unmet", () => {});
    });
}

export function itIf(condition: boolean): TestGate {
  if (condition) {
    return (name, fn, timeout) => it(name, fn, timeout);
  }

  return (name, fn, timeout) => it.skip(name, fn, timeout);
}

export function testIf(condition: boolean): TestGate {
  if (condition) {
    return (name, fn, timeout) => test(name, fn, timeout);
  }

  return (name, fn, timeout) => test.skip(name, fn, timeout);
}
