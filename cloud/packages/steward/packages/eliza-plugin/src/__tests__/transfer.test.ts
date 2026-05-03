import { describe, expect, it } from "vitest";
import { transferAction } from "../actions/transfer.js";

describe("STEWARD_TRANSFER action", () => {
  it("has correct metadata", () => {
    expect(transferAction.name).toBe("STEWARD_TRANSFER");
    expect(transferAction.parameters).toBeDefined();
    expect(transferAction.parameters?.length).toBeGreaterThanOrEqual(2);
  });

  it("requires 'to' parameter", () => {
    const toParam = transferAction.parameters?.find((p) => p.name === "to");
    expect(toParam).toBeDefined();
    expect(toParam?.required).toBe(true);
  });

  it("requires 'amount' parameter", () => {
    const amountParam = transferAction.parameters?.find((p) => p.name === "amount");
    expect(amountParam).toBeDefined();
    expect(amountParam?.required).toBe(true);
  });

  it("has optional 'chain' parameter", () => {
    const chainParam = transferAction.parameters?.find((p) => p.name === "chain");
    expect(chainParam).toBeDefined();
    expect(chainParam?.required).toBeFalsy();
  });

  it("validate returns false without steward service", async () => {
    const mockRuntime = {
      getService: () => null,
    } as any;
    const result = await transferAction.validate(mockRuntime, {} as any);
    expect(result).toBe(false);
  });

  it("handler returns error for missing params", async () => {
    const mockRuntime = {
      getService: () => ({ isConnected: () => true }),
    } as any;

    const result = await transferAction.handler(mockRuntime, {} as any, undefined, {
      parameters: {},
    });

    expect(result).toBeDefined();
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("Missing required parameters");
  });
});
