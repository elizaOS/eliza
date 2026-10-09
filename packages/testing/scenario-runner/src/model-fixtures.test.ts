import { expect, it } from "vitest";
import { compileScenarioModelFixture } from "./model-fixtures.ts";

it("preserves structured response fields without requiring tool calls or usage", () => {
  const response = {
    text: "done",
    thought: "reason",
    messageToUser: "",
    completed: false,
  };
  expect(
    compileScenarioModelFixture({
      name: "structured",
      match: { modelType: "TEXT_LARGE" as const },
      response,
    }).response,
  ).toEqual(response);
  expect(
    compileScenarioModelFixture({
      name: "text",
      match: { modelType: "TEXT_LARGE" as const },
      response: { text: "plain" },
    }).response,
  ).toBe("plain");
});

it("assigns distinct stable default tool IDs and preserves explicit IDs", () => {
  const fixture = {
    name: "tools",
    match: { modelType: "TEXT_LARGE" as const },
    response: {
      toolCalls: [
        { name: "a", arguments: {} },
        { name: "b", arguments: {} },
        { name: "c", arguments: {}, id: "explicit" },
      ],
    },
  };
  const compiled = compileScenarioModelFixture(fixture);
  expect(compiled.response).toMatchObject({
    toolCalls: [
      { id: "call-tools-0" },
      { id: "call-tools-1" },
      { id: "explicit" },
    ],
  });
  expect(compileScenarioModelFixture(fixture).response).toEqual(
    compiled.response,
  );
});
