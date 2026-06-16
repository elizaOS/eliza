import { describe, expect, it } from "vitest";
import { polymarketAction } from "./actions";

describe("polymarket action surface", () => {
  it("exposes place_order as disabled trading-readiness, not live signed order placement", () => {
    // Canonical prediction-market design (mirrors plugin-hyperliquid-app): the
    // action recognizes a `place_order` op, but signed CLOB placement is
    // disabled — `place_order` only reports trading readiness. The description
    // must make that disabled status explicit so the agent never advertises
    // live order placement as available.
    expect(polymarketAction.description).toContain("place_order");
    expect(polymarketAction.description.toLowerCase()).toContain("disabled");

    const actionParameter = polymarketAction.parameters?.find(
      (parameter) => parameter.name === "action",
    );
    expect(actionParameter?.schema).toMatchObject({
      enum: expect.arrayContaining(["read", "place_order"]),
    });
  });
});
