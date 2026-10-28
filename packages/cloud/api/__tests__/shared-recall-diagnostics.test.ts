import { expect, test } from "bun:test";
import { sharedRecallFailureCode } from "./shared-recall-diagnostics";

test("releases only recognized SQLSTATE values through nested database errors", () => {
  expect(
    sharedRecallFailureCode({
      cause: { code: "42703", message: "private SQL" },
    }),
  ).toBe("42703");
  for (const error of [
    null,
    "private",
    { code: "private" },
    { code: "42703\nsecret" },
    new Error("private"),
  ]) {
    expect(sharedRecallFailureCode(error)).toBe("UNKNOWN");
  }
});

test("does not invoke accessors or loop through cyclic causes", () => {
  const error = {
    get code() {
      throw new Error("must not read");
    },
    get cause() {
      throw new Error("must not read");
    },
  };
  expect(sharedRecallFailureCode(error)).toBe("UNKNOWN");
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  expect(sharedRecallFailureCode(cycle)).toBe("UNKNOWN");
});
