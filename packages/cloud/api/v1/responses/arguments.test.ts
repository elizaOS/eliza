import { expect, test } from "bun:test";
import { parseResponsesRequest, ResponsesInputError } from "./compatibility";

function parseArguments(argumentsText: string) {
  return parseResponsesRequest({
    model: "test",
    input: [
      {
        type: "function_call",
        call_id: "original",
        name: "tool",
        arguments: argumentsText,
      },
      {
        type: "function_call_output",
        call_id: "original",
        output: "original result",
      },
    ],
  });
}

for (const [name, value] of [
  ["unsafe integer rounding", "9007199254740993"],
  ["overflow", "1e309"],
  ["positive underflow", "1e-324"],
  ["negative underflow", "-1e-400"],
  ["decimal precision loss", "0.10000000000000001"],
  ["fraction precision loss", "1.234567890123456789"],
  ["negative zero", "-0"],
  ["negative decimal zero", "-0.000e30"],
]) {
  test(`rejects tool argument ${name} before chat conversion`, () => {
    expect(() => parseArguments(`{"number":${value}}`)).toThrow(
      ResponsesInputError,
    );
  });
}

test("preserves equivalent decimal and exponent values without numeric caps", () => {
  const original =
    '{"values":[1.0,1e3,1000e-3,-1.50e1,9007199254740992,1e100,0.00010,10e-5,5e-324,-5e-324,1.7976931348623157e308]}';
  const parsed = parseArguments(original);
  expect(parsed.messages[0].tool_calls?.[0].function.arguments).toBe(original);
  expect(parsed.messages[1].content).toBe("original result");
});

test("numeric-looking quoted strings and escaped quotes remain unchanged", () => {
  const original =
    '{"id":"9007199254740993","overflow":"1e309","underflow":"-1e-400","quoted":"\\"-0\\" and \\\\ 1e309","actual":1.0}';
  expect(
    parseArguments(original).messages[0].tool_calls?.[0].function.arguments,
  ).toBe(original);
});

test("rejects lossy numbers nested in arrays and objects", () => {
  expect(() =>
    parseArguments('{"outer":[{"quoted":"1e309","actual":1e309}]}'),
  ).toThrow(ResponsesInputError);
});

test("accepts long exact mantissas and exponent-equivalent forms", () => {
  const original = `{"number":1${"0".repeat(1000)}e-1000,"zero":0e${"9".repeat(1000)}}`;
  expect(
    parseArguments(original).messages[0].tool_calls?.[0].function.arguments,
  ).toBe(original);
});

test("rejects nonzero overflow with a long exponent without expanding it", () => {
  expect(() => parseArguments(`{"number":1e${"9".repeat(1000)}}`)).toThrow(
    ResponsesInputError,
  );
});

test("accepts leading-zero exponents and empty numeric-looking property names", () => {
  const original = '{"9007199254740993":1.2500e+00002,"-0":0e-00000000}';
  expect(
    parseArguments(original).messages[0].tool_calls?.[0].function.arguments,
  ).toBe(original);
});
