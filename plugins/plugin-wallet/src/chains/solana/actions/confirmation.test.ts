import { describe, expect, it, vi } from "vitest";
import { confirmationRequired, isConfirmed } from "./confirmation";

describe("confirmationRequired (wallet solana)", () => {
  it("never trusts LLM-supplied confirmed flags (GHSA-rqm7-f4jc-84x3)", () => {
    expect(isConfirmed({ confirmed: true })).toBe(false);
    expect(isConfirmed({ confirmed: "yes" })).toBe(false);
    expect(isConfirmed({ confirmed: 1 })).toBe(false);
    expect(isConfirmed(undefined)).toBe(false);
    expect(isConfirmed()).toBe(false);
  });

  it("normalizes scalar and bigint parameter values to JSON-safe shapes", async () => {
    const callback = vi.fn();
    const result = await confirmationRequired({
      actionName: "swap",
      preview: "Swap 1 ETH",
      parameters: {
        amount: 1n,
        token: "ETH",
        extra: undefined,
        tags: [1, 2n, null, true],
      },
      callback,
    });

    expect(result.success).toBe(false);
    const data = result.data as {
      requiresConfirmation: boolean;
      preview: string;
      confirmation: {
        actionName: string;
        parameters: Record<string, unknown>;
      };
    };
    expect(data.requiresConfirmation).toBe(true);
    expect(data.preview).toBe("Swap 1 ETH");
    expect(data.confirmation.actionName).toBe("swap");
    expect(data.confirmation.parameters).toEqual({
      amount: "1",
      token: "ETH",
      extra: null,
      tags: [1, "2", null, true],
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: "Swap 1 ETH" }));
  });

  it("surfaces cyclic parameter graphs as a marker instead of crashing", async () => {
    const cyclic: Record<string, unknown> = { name: "swap" };
    cyclic.self = cyclic;

    const result = await confirmationRequired({
      actionName: "swap",
      preview: "Swap",
      parameters: cyclic,
    });

    // eslint-disable-next-line no-console
    const data = result.data as {
      confirmation: { parameters: Record<string, unknown> };
    };
    expect(data.confirmation.parameters.self).toBe("[Circular]");
  });

  it("surfaces shared (diamond) references without false circular markers", async () => {
    const shared = { address: "0xabc" };
    const result = await confirmationRequired({
      actionName: "swap",
      preview: "Swap",
      parameters: { from: shared, to: shared },
    });

    const data = result.data as {
      confirmation: { parameters: Record<string, unknown> };
    };
    expect(data.confirmation.parameters.from).toEqual({ address: "0xabc" });
    expect(data.confirmation.parameters.to).toEqual({ address: "0xabc" });
  });

  it("does not collapse non-plain objects (Date, Map) to empty records", async () => {
    const when = new Date("2026-01-02T03:04:05.000Z");
    const result = await confirmationRequired({
      actionName: "swap",
      preview: "Swap",
      parameters: { when, tags: new Map([["k", "v"]]) },
    });

    const data = result.data as {
      confirmation: { parameters: Record<string, unknown> };
    };
    const parameters = data.confirmation.parameters;
    expect(typeof parameters.when).toBe("string");
    expect(parameters.when).toContain("2026");
    expect(typeof parameters.tags).toBe("string");
    expect(parameters.tags.length).toBeGreaterThan(0);
  });

  it("omits the callback when none is supplied", async () => {
    const result = await confirmationRequired({
      actionName: "swap",
      preview: "Swap",
      parameters: {},
    });
    expect(result.success).toBe(false);
  });
});
