/**
 * Unit tests for the PREDICTION_MARKET action: context-routing validation
 * (structured `__contextRouting`/`selectedContexts`, no keyword-bank matching)
 * and the disabled-trading-readiness shape of `place_order`. No network or
 * runtime dependencies — `runtime`/`state` are plain fixtures.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { polymarketAction } from "./actions";

const runtime = {} as IAgentRuntime;

function msg(text = ""): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text, source: "test" },
    createdAt: 0,
  } as unknown as Memory;
}

function stateWithRouting(routing: unknown): State {
  return {
    values: { __contextRouting: routing },
    data: {},
    text: "",
  } as unknown as State;
}

describe("PREDICTION_MARKET validate (#10471 — structured context, no keyword bank)", () => {
  it("validates when routed to a prediction-market context via __contextRouting", async () => {
    expect(
      await polymarketAction.validate?.(
        runtime,
        msg(),
        stateWithRouting({ primaryContext: "prediction-market" }),
      ),
    ).toBe(true);
  });

  it("validates from a secondary finance/crypto context", async () => {
    expect(
      await polymarketAction.validate?.(
        runtime,
        msg(),
        stateWithRouting({
          primaryContext: "chat",
          secondaryContexts: ["crypto"],
        }),
      ),
    ).toBe(true);
  });

  it("validates from the legacy selectedContexts signal", async () => {
    expect(
      await polymarketAction.validate?.(runtime, msg(), {
        values: { selectedContexts: ["payments"] },
      } as unknown as State),
    ).toBe(true);
  });

  it("does NOT validate a non-market routed context", async () => {
    expect(
      await polymarketAction.validate?.(
        runtime,
        msg(),
        stateWithRouting({ primaryContext: "chat" }),
      ),
    ).toBe(false);
  });

  it("does NOT validate on market keyword text alone — the keyword bank is gone", async () => {
    expect(
      await polymarketAction.validate?.(
        runtime,
        msg("what are the polymarket odds? should I buy?"),
        stateWithRouting({ primaryContext: "chat" }),
      ),
    ).toBe(false);
    expect(
      await polymarketAction.validate?.(
        runtime,
        msg("mercado de predicción / 予測市場"),
      ),
    ).toBeFalsy();
  });
});

describe("polymarket action surface", () => {
  it("exposes place_order as disabled trading-readiness, not live signed order placement", () => {
    // Canonical prediction-market design (mirrors plugin-hyperliquid): the
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
