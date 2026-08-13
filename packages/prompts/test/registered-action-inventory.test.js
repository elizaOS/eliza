/** Verifies registered action discovery across supported TypeScript quote styles. */
import { describe, expect, test } from "bun:test";
import { extractActionNames } from "../scripts/registered-action-inventory.js";

describe("registered action inventory", () => {
  test("discovers literal, constant, and factory names with either quote style", () => {
    const source = `
      const SINGLE_NAME = 'SINGLE_CONST';
      export const singleLiteral: Action = { name: 'SINGLE_LITERAL' };
      export const singleConst: Action = { name: SINGLE_NAME };
      export const doubleLiteral: Action = { name: "DOUBLE_LITERAL" };
      export const factoryAction: Action = createAction('FACTORY_ACTION');
    `;

    expect([...extractActionNames(source)].sort()).toEqual([
      "DOUBLE_LITERAL",
      "FACTORY_ACTION",
      "SINGLE_CONST",
      "SINGLE_LITERAL",
    ]);
  });
});
