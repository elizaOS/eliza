import { expect, it } from "vitest";
import { createMockRuntime } from "./mock-runtime.ts";

it("isolates nested defaults while honoring explicit character overrides", () => {
  const first = createMockRuntime();
  const second = createMockRuntime();
  first.character.name = "mutated";
  first.character.settings = { privateValue: "first" };
  first.character.topics?.push("first");
  expect(second.character.name).toBe("MockAgent");
  expect(second.character.settings).toEqual({});
  expect(second.character.topics).toEqual([]);
  expect(createMockRuntime({ character: first.character }).character).toBe(
    first.character,
  );
});
