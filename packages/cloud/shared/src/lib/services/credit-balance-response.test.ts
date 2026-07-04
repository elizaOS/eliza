import { describe, expect, spyOn, test } from "bun:test";
import { getCreditBalanceResponse } from "./credit-balance-response";
import { organizationsService } from "./organizations";

describe("getCreditBalanceResponse", () => {
  test("returns a finite numeric organization credit balance", async () => {
    const getByIdSpy = spyOn(organizationsService, "getById").mockResolvedValue({
      credit_balance: "12.340000",
    } as never);
    try {
      await expect(getCreditBalanceResponse("org-1")).resolves.toEqual({
        balance: 12.34,
      });
    } finally {
      getByIdSpy.mockRestore();
    }
  });

  test("fails closed on corrupt organization credit balance values", async () => {
    for (const value of ["12abc", "", "Infinity"]) {
      const getByIdSpy = spyOn(organizationsService, "getById").mockResolvedValue({
        credit_balance: value,
      } as never);
      try {
        await expect(getCreditBalanceResponse("org-1")).rejects.toThrow(
          "[CreditBalanceResponse] Invalid numeric organization.credit_balance",
        );
      } finally {
        getByIdSpy.mockRestore();
      }
    }
  });
});
