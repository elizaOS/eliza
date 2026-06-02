import { describe, expect, it } from "vitest";
import { polymarketAction } from "./actions";

describe("polymarket action surface", () => {
  it("does not expose disabled order placement as an agent action", () => {
    expect(polymarketAction.description).not.toContain("place_order");
    expect(polymarketAction.descriptionCompressed).not.toContain("place_order");
    expect(polymarketAction.similes).not.toEqual(
      expect.arrayContaining([
        "POLYMARKET_PLACE_ORDER",
        "POLYMARKET_TRADE",
        "POLYMARKET_BUY",
        "POLYMARKET_SELL",
      ]),
    );

    const actionParameter = polymarketAction.parameters?.find(
      (parameter) => parameter.name === "action",
    );
    expect(actionParameter?.schema).toMatchObject({ enum: ["read"] });
    expect(
      polymarketAction.parameters?.map((parameter) => parameter.name),
    ).not.toEqual(expect.arrayContaining(["side", "marketId", "amount"]));
  });
});
