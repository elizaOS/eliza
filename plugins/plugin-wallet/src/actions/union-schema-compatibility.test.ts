import { describe, expect, it } from "vitest";
import { actionToJsonSchema } from "../../../../packages/core/src/actions/action-schema";
import { validateSchema } from "../../../../packages/core/src/actions/validate-tool-args";
import { liquidityAction } from "../lp/actions/liquidity";
import { tradeRouterAction } from "./trade-action";

describe("wallet mixed-type parameter compatibility", () => {
  for (const [action, fields] of [
    [tradeRouterAction, ["limitPx", "amount", "price"]],
    [liquidityAction, ["amount"]],
  ] as const) {
    for (const field of fields) {
      it(`${action.name}.${field} keeps accepting numbers and strings without execution`, () => {
        const schema = actionToJsonSchema(action).properties[field];
        expect(schema.type).toBeUndefined();
        for (const input of [1.25, "1.25", "0.000000000000000001"]) {
          const errors: string[] = [];
          expect(validateSchema(schema, input, field, errors)).toBe(input);
          expect(errors).toEqual([]);
        }
        const errors: string[] = [];
        validateSchema(schema, {}, field, errors);
        expect(errors.length).toBeGreaterThan(0);
      });
    }
  }
});
