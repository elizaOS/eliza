import { describe, it, test } from "vitest";

type SuiteCallback = () => void | Promise<void>;
type TestCallback = () => void | Promise<void>;

type DescribeGate = (
  name: string | Function,
  fn: SuiteCallback,
) => ReturnType<typeof describe>;

type TestGate = (
  name: string | Function,
  fn: TestCallback,
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
    return (name, fn) => it(name, fn);
  }

  return (name, fn) => it.skip(name, fn);
}

export function testIf(condition: boolean): TestGate {
  if (condition) {
    return (name, fn) => test(name, fn);
  }

  return (name, fn) => test.skip(name, fn);
}
